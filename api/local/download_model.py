import json
import os
import re
import sys
import shutil
import argostranslate.package as package


def has_model(model_dir: str) -> bool:
    if not model_dir or not os.path.isdir(model_dir):
        return False
    for name in os.listdir(model_dir):
        if name.endswith('.argosmodel'):
            return True
    return False


def normalize_code(code: str, fallback: str = '') -> str:
    if not code:
        return fallback
    normalized = str(code).strip().lower()
    if normalized.startswith('zh'):
        return 'zh'
    return re.split(r'[-_]', normalized)[0] or fallback


def get_model_dir(arg) -> str:
    model_dir = arg or os.environ.get('LOCAL_TRANSLATE_MODEL_DIR', '')
    return model_dir or ''


def list_available_packages() -> int:
    package.update_package_index()
    packages = package.get_available_packages()
    results = []
    for p in packages:
        results.append(
            {
                'from_code': getattr(p, 'from_code', ''),
                'to_code': getattr(p, 'to_code', ''),
                'package_name': getattr(p, 'package_name', ''),
                'package_version': getattr(p, 'package_version', ''),
                'size': getattr(p, 'size', None) if hasattr(p, 'size') else getattr(p, 'file_size', None)
            }
        )
    print(json.dumps(results, ensure_ascii=False))
    return 0


def download_specific(model_dir: str, from_code: str, to_code: str) -> int:
    os.makedirs(model_dir, exist_ok=True)
    package.update_package_index()
    packages = package.get_available_packages()

    selected = None
    for p in packages:
        if normalize_code(p.from_code) == normalize_code(from_code) and normalize_code(p.to_code) == normalize_code(to_code):
            selected = p
            break
    if not selected:
        sys.stderr.write('no_requested_model\n')
        return 3

    download_path = selected.download()
    dest_name = f"{selected.from_code}-{selected.to_code}.argosmodel"
    dest_path = os.path.join(model_dir, dest_name)
    shutil.copyfile(download_path, dest_path)
    print(
        json.dumps(
            {
                'ok': True,
                'from_code': selected.from_code,
                'to_code': selected.to_code,
                'path': dest_path
            },
            ensure_ascii=False
        )
    )
    return 0


def main() -> int:
    command = None
    model_dir = None
    from_code = None
    to_code = None

    if len(sys.argv) > 1 and sys.argv[1] in ('list', 'download'):
        command = sys.argv[1]
        if len(sys.argv) > 2:
            model_dir = sys.argv[2]
        if command == 'download' and len(sys.argv) > 4:
            from_code = sys.argv[3]
            to_code = sys.argv[4]
    elif len(sys.argv) > 1:
        model_dir = sys.argv[1]

    model_dir = get_model_dir(model_dir)
    if command == 'list':
        return list_available_packages()
    if command == 'download':
        if not model_dir:
            sys.stderr.write('missing model_dir\n')
            return 2
        if not from_code or not to_code:
            sys.stderr.write('missing_lang_pair\n')
            return 2
        return download_specific(model_dir, from_code, to_code)

    if not model_dir:
        sys.stderr.write('missing model_dir\n')
        return 2

    os.makedirs(model_dir, exist_ok=True)
    if has_model(model_dir):
        print('model_exists')
        return 0

    print('updating_index')
    package.update_package_index()
    packages = package.get_available_packages()

    selected = None
    for p in packages:
        if p.from_code == 'en' and (p.to_code == 'zh' or p.to_code.startswith('zh')):
            selected = p
            break
    if not selected:
        sys.stderr.write('no_en_zh_model\n')
        return 3

    print(f'downloading {selected.from_code}->{selected.to_code} {selected.package_version}')
    download_path = selected.download()
    dest_name = f"{selected.from_code}-{selected.to_code}.argosmodel"
    dest_path = os.path.join(model_dir, dest_name)
    shutil.copyfile(download_path, dest_path)
    print(f'downloaded_to {dest_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
