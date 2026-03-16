import json
import os
import sys
import traceback

try:
    import argostranslate.package
    import argostranslate.translate
except Exception as exc:
    sys.stderr.write(f"failed to import argostranslate: {exc}\n")
    sys.stderr.flush()
    raise


def load_local_models(model_dir: str) -> None:
    if not model_dir or not os.path.isdir(model_dir):
        return
    for entry in os.listdir(model_dir):
        if not entry.endswith('.argosmodel'):
            continue
        model_path = os.path.join(model_dir, entry)
        try:
            argostranslate.package.install_from_path(model_path)
        except Exception as exc:
            sys.stderr.write(f"install model failed {model_path}: {exc}\n")
            sys.stderr.flush()


def translate_items(items, from_code: str, to_code: str):
    translation = argostranslate.translate.get_translation_from_codes(from_code, to_code)
    if translation is None:
        raise RuntimeError(f"no_translation_pair:{from_code}->{to_code}")

    results = []
    for item in items:
        text = item.get('text') or ''
        translated = translation.translate(text)
        results.append(
            {
                'id': str(item.get('id') or ''),
                'translated_text': translated,
                'confidence': 0.8
            }
        )
    return results


def handle_payload(payload):
    items = payload.get('items') or []
    source_lang = payload.get('source_lang') or 'en'
    target_lang = payload.get('target_lang') or 'zh'
    return {'items': translate_items(items, source_lang, target_lang)}


def main() -> None:
    model_dir = os.environ.get('LOCAL_TRANSLATE_MODEL_DIR', '')
    load_local_models(model_dir)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            response = handle_payload(payload)
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            err = f"worker_error:{exc}"
            sys.stderr.write(err + "\n")
            sys.stderr.write(traceback.format_exc() + "\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({'error': err}) + "\n")
            sys.stdout.flush()


if __name__ == '__main__':
    main()
