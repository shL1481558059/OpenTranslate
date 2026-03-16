import os
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


def main() -> int:
    model_dir = None
    if len(sys.argv) > 1:
        model_dir = sys.argv[1]
    if not model_dir:
        model_dir = os.environ.get('LOCAL_TRANSLATE_MODEL_DIR', '')
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
