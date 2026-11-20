"""Install the approved local RU->EN runtime inside this project only."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.request
import venv
import zipfile

root = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1]
runtime = root / '.translation-runtime'
runtime.mkdir(exist_ok=True)
environment = runtime / 'p'  # Keep Windows paths below MAX_PATH inside a long project path.
python = environment / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
if not python.exists():
    venv.EnvBuilder(with_pip=True).create(environment)
print('Installing local CPU translation dependencies...', flush=True)
wheel_directory = runtime / 'wheels'
pip_args = ['--no-index', '--find-links', str(wheel_directory)] if sys.platform=='win32' and wheel_directory.exists() and len(list(wheel_directory.glob('*.whl'))) >= 5 else []
subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-compile', '--only-binary=:all:', *pip_args, 'ctranslate2==4.8.0', 'sentencepiece==0.2.1'], check=True)
url = 'https://argos-net.com/v1/translate-ru_en-1_9.argosmodel'
archive = runtime / 'translate-ru_en-1_9.argosmodel'
if not archive.exists():
    partial = archive.with_suffix('.download')
    print('Downloading the public RU->EN model. No BOM text is transmitted.', flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
        count = 0
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > 512 * 1024 * 1024:
                raise RuntimeError('Model exceeds the 512 MiB download limit')
            output.write(chunk)
    partial.rename(archive)
model = runtime / 'models' / 'ru-en'
model.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as package:
    for entry in package.infolist():
        target = (model / entry.filename).resolve()
        if not target.is_relative_to(model.resolve()) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
            raise RuntimeError('Unsafe model archive entry')
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                with package.open(entry) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
model_binary = next(model.rglob('model.bin'))
tokenizer = next(model.rglob('sentencepiece.model'))
manifest = {'engine': 'CTranslate2', 'engineVersion': '4.8.0', 'tokenizerVersion': '0.2.1', 'language': 'ru-en', 'modelUrl': url, 'modelVersion': '1.9', 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'modelDirectory': str(model_binary.parent.relative_to(runtime)), 'tokenizer': str(tokenizer.relative_to(runtime)), 'modelSha256': hashlib.sha256(model_binary.read_bytes()).hexdigest()}
(runtime / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'ready': True, 'modelMiB': round(model_binary.stat().st_size/1024/1024), 'archiveSha256': manifest['archiveSha256']}), flush=True)
