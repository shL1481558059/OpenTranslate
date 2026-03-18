import json
import os
import sys
import traceback
import re

try:
    import torch
    from transformers import MarianMTModel, MarianTokenizer
    from huggingface_hub import snapshot_download
except Exception as exc:
    sys.stderr.write(f"failed to import marian deps: {exc}\n")
    sys.stderr.flush()
    raise

MODEL_CACHE = {}


def normalize_device(device: str) -> str:
    if not device:
        return "cpu"
    device = str(device).lower()
    if device.startswith("cuda") and torch.cuda.is_available():
        return device
    return "cpu"


def normalize_dtype(dtype: str):
    if not dtype:
        return None
    dtype = str(dtype).lower()
    if dtype in ("fp16", "float16"):
        return torch.float16
    if dtype in ("bf16", "bfloat16"):
        return torch.bfloat16
    if dtype in ("fp32", "float32"):
        return torch.float32
    return None


def safe_model_dir(model_dir: str, model_id: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", model_id)
    return os.path.join(model_dir, safe)


def ensure_model_downloaded(model_id: str, local_dir: str) -> str:
    os.makedirs(local_dir, exist_ok=True)
    snapshot_download(
        repo_id=model_id,
        local_dir=local_dir,
        local_dir_use_symlinks=False
    )
    meta_path = os.path.join(local_dir, "model.json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump({"model_id": model_id}, handle, ensure_ascii=False)
    return local_dir


def load_model(model_id: str, local_dir: str, device: str, dtype):
    key = (local_dir or model_id, device, str(dtype))
    if key in MODEL_CACHE:
        return MODEL_CACHE[key]

    if local_dir and not os.path.isdir(local_dir):
        raise RuntimeError(f"missing_model:{model_id}")

    source = local_dir or model_id
    tokenizer = MarianTokenizer.from_pretrained(source)
    model = MarianMTModel.from_pretrained(source)
    if dtype is not None:
        try:
            model = model.to(dtype=dtype)
        except Exception:
            pass
    model.to(device)
    model.eval()
    MODEL_CACHE[key] = (tokenizer, model, device)
    return MODEL_CACHE[key]


def translate_items(items, model_id: str, local_dir: str, device: str, dtype, max_tokens: int, batch_size: int):
    tokenizer, model, device = load_model(model_id, local_dir, device, dtype)
    texts = [str(item.get("text") or "") for item in items]
    if not texts:
        return []
    results = []
    size = max(1, int(batch_size))
    for start in range(0, len(texts), size):
        chunk_texts = texts[start:start + size]
        batch = tokenizer(chunk_texts, return_tensors="pt", padding=True, truncation=True)
        batch = {k: v.to(device) for k, v in batch.items()}
        with torch.no_grad():
            generated = model.generate(**batch, max_new_tokens=max_tokens)
        outputs = tokenizer.batch_decode(generated, skip_special_tokens=True)
        for offset, item in enumerate(items[start:start + size]):
            translated = outputs[offset] if offset < len(outputs) else ""
            results.append(
                {
                    "id": str(item.get("id") or ""),
                    "translated_text": translated,
                    "confidence": 0.8
                }
            )
    return results


def handle_payload(payload):
    action = payload.get("action") or "translate"
    model_id = payload.get("model_id") or os.environ.get("MARIAN_MODEL_ID") or ""
    model_dir = payload.get("local_dir") or os.environ.get("LOCAL_MARIAN_MODEL_DIR") or ""
    device = normalize_device(payload.get("device") or os.environ.get("MARIAN_DEVICE"))
    dtype = normalize_dtype(payload.get("dtype") or os.environ.get("MARIAN_DTYPE"))
    max_tokens = payload.get("max_tokens") or os.environ.get("MARIAN_MAX_TOKENS") or 512
    try:
        max_tokens = int(max_tokens)
    except Exception:
        max_tokens = 512
    try:
        batch_size = int(payload.get("batch_size") or os.environ.get("MARIAN_BATCH_SIZE") or 8)
    except Exception:
        batch_size = 8

    if not model_id:
        raise RuntimeError("missing_model:")

    if not model_dir:
        model_dir = os.getcwd()

    if action == "download":
        local_dir = payload.get("local_dir") or safe_model_dir(model_dir, model_id)
        ensure_model_downloaded(model_id, local_dir)
        return {"ok": True, "model_id": model_id, "local_dir": local_dir}

    if action == "translate":
        local_dir = payload.get("local_dir") or safe_model_dir(model_dir, model_id)
        items = payload.get("items") or []
        return {"items": translate_items(items, model_id, local_dir, device, dtype, max_tokens, batch_size)}

    raise RuntimeError("invalid_action")


def main() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        payload = {}
        try:
            payload = json.loads(line)
            response = handle_payload(payload)
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            message = str(exc)
            if "404" in message or "not found" in message.lower():
                err = f"missing_model:{payload.get('model_id') or ''}"
            else:
                err = f"worker_error:{message}"
            sys.stderr.write(err + "\n")
            sys.stderr.write(traceback.format_exc() + "\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({"error": err}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
