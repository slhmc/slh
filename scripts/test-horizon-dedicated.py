"""Opt-in native server smoke test; reads prepared resources, writes a private world."""
import argparse
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--release', type=Path, required=True)
parser.add_argument('--minecraft', default='26.3')
parser.add_argument('--timeout', type=int, default=600)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='slh-horizon-dedicated-'))
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
(root / 'eula.txt').write_text('eula=true\n')
(root / 'server.properties').write_text(
    f'server-ip=127.0.0.1\nserver-port={port}\nonline-mode=true\n'
    'view-distance=2\nsimulation-distance=2\nlevel-type=minecraft:flat\nlevel-name=world\n')
program = args.release / ('horizon-client.exe' if os.name == 'nt' else 'horizon-client')
process = subprocess.Popen([str(program), '--resources', str(args.release / '.local/horizon-client' / args.minecraft),
                            '--dedicated', '--nogui'], cwd=root,
    env=dict(os.environ, HORIZON_HOME=str(root), HORIZON_NO_AUDIO='1', HORIZON_NO_TELEMETRY='1'),
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, encoding='utf-8', errors='replace', creationflags=0x08000000 if os.name == 'nt' else 0)
lines = []
events = queue.Queue()
def read_output():
    for line in process.stdout:
        lines.append(line)
        events.put(line)
threading.Thread(target=read_output, daemon=True).start()
def varint(value):
    value &= 0xffffffff
    data = bytearray()
    while value > 127:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return bytes(data)
def read_varint(connection):
    result = 0
    for index in range(5):
        value = connection.recv(1)
        if not value:
            raise RuntimeError('Unexpected end of status response')
        value = value[0]
        result |= (value & 127) << (7 * index)
        if value < 128:
            return result
    raise RuntimeError('Invalid VarInt')
try:
    deadline = time.monotonic() + args.timeout
    print('Waiting for dedicated server:', root, flush=True)
    while True:
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Server not ready: ' + ''.join(lines[-15:]))
        try:
            line = events.get(timeout=1)
        except queue.Empty:
            continue
        if 'Done (' in line:
            break
    with socket.create_connection(('127.0.0.1', port), timeout=15) as connection:
        host = b'127.0.0.1'
        handshake = b'\0' + varint(-1) + varint(len(host)) + host + struct.pack('>H', port) + b'\1'
        connection.sendall(varint(len(handshake)) + handshake + b'\1\0')
        read_varint(connection)
        assert read_varint(connection) == 0
        length = read_varint(connection)
        assert 0 < length <= 1024 * 1024
        data = b''
        while len(data) < length:
            chunk = connection.recv(length - len(data))
            if not chunk:
                raise RuntimeError('Truncated server status')
            data += chunk
        status = json.loads(data)
        assert args.minecraft in status['version']['name']
        print('Status:', status['version']['name'], 'players:', status['players']['online'], flush=True)
    process.stdin.write('list\nsave-all\nstop\n')
    process.stdin.flush()
    process.wait(timeout=60)
    assert process.returncode == 0, ''.join(lines[-15:])
    print('PASS: dedicated startup, status query, console commands, graceful stop', flush=True)
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    (root / 'smoke-console.log').write_text(''.join(lines), encoding='utf-8')
