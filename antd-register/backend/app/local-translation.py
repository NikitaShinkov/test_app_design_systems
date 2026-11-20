"""Offline RU->EN inference. stdin/stdout are a single bounded JSON exchange."""
import json
import os
import pathlib
import sys
import threading
import time

def main():
    runtime = pathlib.Path(sys.argv[1]).resolve()
    manifest = json.loads((runtime / 'manifest.json').read_text(encoding='utf-8'))
    data = json.loads(sys.stdin.buffer.readline(4 * 1024 * 1024 + 2).decode('utf-8'))
    # The calling file worker keeps stdin open while inference is owned. If
    # cancellation/termination closes that pipe, stop even during native work.
    owner_fd = sys.stdin.fileno()
    if os.name == 'nt':
        import ctypes
        import msvcrt
        from ctypes import wintypes
        owner_handle = wintypes.HANDLE(msvcrt.get_osfhandle(owner_fd))
        peek = ctypes.WinDLL('kernel32', use_last_error=True).PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        peek.restype = wintypes.BOOL
    def owner_closed():
        while True:
            if os.name == 'nt':
                # A blocking CRT read can deadlock NumPy DLL initialization.
                # Probe the inherited pipe without taking the stdin CRT lock.
                if not peek(owner_handle, None, 0, None, None, None):
                    os._exit(125)
                time.sleep(0.25)
            else:
                import select
                if select.select([owner_fd], [], [], 0.25)[0] and os.read(owner_fd, 1) == b'':
                    os._exit(125)
    threading.Thread(target=owner_closed, daemon=True).start()
    deadline = threading.Timer(100, lambda: os._exit(124))
    deadline.daemon = True
    deadline.start()
    texts = data['texts']
    if not isinstance(texts, list) or len(texts) > 20000 or any(not isinstance(t, str) for t in texts):
        raise ValueError('Invalid local translation request')
    import ctranslate2
    import sentencepiece
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(runtime / manifest['tokenizer']))
    engine = ctranslate2.Translator(str(runtime / manifest['modelDirectory']), device='cpu', compute_type='int8', inter_threads=1, intra_threads=1)
    batches, owners = [], []
    for index, text in enumerate(texts):
        tokens = tokenizer.encode(text, out_type=str)
        while tokens:
            end = min(len(tokens), 240)
            if end < len(tokens):
                while end > 120 and not tokens[end].startswith('▁'):
                    end -= 1
            batches.append(tokens[:end])
            owners.append(index)
            tokens = tokens[end:]
    translated = [[] for _ in texts]
    for start in range(0, len(batches), 16):
        results = engine.translate_batch(batches[start:start + 16], beam_size=2, max_batch_size=16, max_input_length=256, max_decoding_length=512, repetition_penalty=1.1)
        for offset, result in enumerate(results):
            translated[owners[start + offset]].append(tokenizer.decode(result.hypotheses[0]))
    sys.stdout.buffer.write(json.dumps({'translations': [' '.join(parts) for parts in translated]}, ensure_ascii=False).encode('utf-8'))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
