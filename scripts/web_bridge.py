#!/usr/bin/env python3
"""
WebSocket Bridge Server for Klipper Virtual Serial Device (/tmp/printer).
Bridges web browser clients (via WebSocket on ws://127.0.0.1:8765) to /tmp/printer.
"""

import asyncio
import os
import sys
import hashlib
import base64
import struct
import time

HOST = "127.0.0.1"
PORT = 8765
SERIAL_PATH = "/tmp/printer"

clients = set()
serial_fd = None

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def make_frame(payload):
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    length = len(payload)
    if length <= 125:
        header = struct.pack("BB", 0x81, length)
    elif length <= 65535:
        header = struct.pack("!BBH", 0x81, 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 127, length)
    return header + payload

def parse_frames(buffer):
    frames = []
    while len(buffer) >= 2:
        first_byte = buffer[0]
        opcode = first_byte & 0x0F
        second_byte = buffer[1]
        has_mask = bool(second_byte & 0x80)
        payload_len = second_byte & 0x7F

        idx = 2
        if payload_len == 126:
            if len(buffer) < 4:
                break
            payload_len = struct.unpack("!H", buffer[2:4])[0]
            idx = 4
        elif payload_len == 127:
            if len(buffer) < 10:
                break
            payload_len = struct.unpack("!Q", buffer[2:10])[0]
            idx = 10

        mask_key = None
        if has_mask:
            if len(buffer) < idx + 4:
                break
            mask_key = buffer[idx:idx+4]
            idx += 4

        if len(buffer) < idx + payload_len:
            break

        raw_payload = buffer[idx:idx+payload_len]
        buffer = buffer[idx+payload_len:]

        if mask_key:
            decoded = bytearray(len(raw_payload))
            for i in range(len(raw_payload)):
                decoded[i] = raw_payload[i] ^ mask_key[i % 4]
            payload = bytes(decoded)
        else:
            payload = raw_payload

        # Opcode 8 is Close, 9 is Ping, 10 is Pong, 1 is Text, 2 is Binary
        if opcode == 8:
            return frames, None  # Signal close
        elif opcode in (1, 2):
            frames.append(payload)

    return frames, buffer

async def handle_client(reader, writer):
    global serial_fd
    peer = writer.get_extra_info('peername')
    print(f"[Bridge] New client connected from {peer}")

    # Perform WebSocket Handshake
    try:
        header_data = b""
        while b"\r\n\r\n" not in header_data:
            chunk = await reader.read(1024)
            if not chunk:
                return
            header_data += chunk

        headers = {}
        lines = header_data.decode('utf-8', errors='ignore').split('\r\n')
        for line in lines[1:]:
            if ":" in line:
                key, val = line.split(":", 1)
                headers[key.strip().lower()] = val.strip()

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.close()
            return

        accept_val = base64.b64encode(
            hashlib.sha1((ws_key + WS_MAGIC).encode('utf-8')).digest()
        ).decode('utf-8')

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
        )
        writer.write(response.encode('utf-8'))
        await writer.drain()

        clients.add(writer)
        print(f"[Bridge] Handshake complete for {peer}")

        # Send initial status frame
        writer.write(make_frame("[Bridge] Connected to /tmp/printer WebSocket server\n"))
        await writer.drain()

        # Read frames from WebSocket
        buf = b""
        while True:
            data = await reader.read(4096)
            if not data:
                break
            buf += data
            frames, buf = parse_frames(buf)
            if buf is None:  # Close opcode
                break
            for frame in frames:
                cmd_text = frame.decode('utf-8', errors='ignore').strip()
                if cmd_text:
                    print(f"[Client -> Serial] {cmd_text}")
                    if serial_fd is not None:
                        try:
                            os.write(serial_fd, (cmd_text + "\n").encode('utf-8'))
                        except Exception as e:
                            print(f"[Error writing to serial] {e}")
                    else:
                        print("[Bridge Warning] /tmp/printer not currently open")

    except Exception as e:
        print(f"[Client Error] {e}")
    finally:
        clients.discard(writer)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        print(f"[Bridge] Client disconnected: {peer}")

def on_serial_readable():
    global serial_fd
    if serial_fd is None:
        return
    try:
        data = os.read(serial_fd, 4096)
        if data:
            frame = make_frame(data)
            dead = set()
            for w in clients:
                try:
                    w.write(frame)
                except Exception:
                    dead.add(w)
            for d in dead:
                clients.discard(d)
    except Exception as e:
        print(f"[Serial Read Error] {e}")

def open_serial():
    global serial_fd
    if os.path.exists(SERIAL_PATH):
        try:
            serial_fd = os.open(SERIAL_PATH, os.O_RDWR | os.O_NONBLOCK)
            print(f"[Bridge] Opened virtual serial device at {SERIAL_PATH}")
            loop = asyncio.get_event_loop()
            loop.add_reader(serial_fd, on_serial_readable)
            return True
        except Exception as e:
            print(f"[Bridge Error] Could not open {SERIAL_PATH}: {e}")
    else:
        print(f"[Bridge] {SERIAL_PATH} does not exist yet. Will keep monitoring...")
    return False

async def monitor_serial():
    global serial_fd
    while True:
        if serial_fd is None:
            open_serial()
        await asyncio.sleep(2)

async def main():
    print(f"Starting Klipper Web Bridge Server on ws://{HOST}:{PORT} ...")
    open_serial()

    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"WebSocket bridge server running on ws://{HOST}:{PORT}")

    asyncio.create_task(monitor_serial())

    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down bridge server.")
