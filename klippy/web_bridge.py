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
import threading
import logging

HOST = "127.0.0.1"
PORT = 8765
SERIAL_PATH = "/tmp/printer"

clients = set()
serial_fd = None
running_loop = None

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
    global serial_fd, running_loop
    peer = writer.get_extra_info('peername')
    logging.info(f"[Bridge] New client connected from {peer}")

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
        logging.info(f"[Bridge] Handshake complete for {peer}")

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
                    logging.info(f"[Client -> Serial] {cmd_text}")
                    if serial_fd is not None:
                        try:
                            os.write(serial_fd, (cmd_text + "\n").encode('utf-8'))
                        except Exception as e:
                            logging.error(f"[Error writing to serial] {e}")
                            if serial_fd is not None and running_loop is not None:
                                try:
                                    running_loop.remove_reader(serial_fd)
                                    os.close(serial_fd)
                                except Exception:
                                    pass
                                serial_fd = None
                    else:
                        logging.warning("[Bridge Warning] virtual serial device not currently open")

    except Exception as e:
        logging.error(f"[Client Error] {e}")
    finally:
        clients.discard(writer)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        logging.info(f"[Bridge] Client disconnected: {peer}")

def on_serial_readable():
    global serial_fd, running_loop
    if serial_fd is None:
        return
    try:
        data = os.read(serial_fd, 4096)
        if data:
            frame = make_frame(data)
            dead = set()
            for w in list(clients):
                try:
                    w.write(frame)
                except Exception:
                    dead.add(w)
            for d in dead:
                clients.discard(d)
    except Exception as e:
        logging.error(f"[Serial Read Error] {e}")
        if serial_fd is not None and running_loop is not None:
            try:
                running_loop.remove_reader(serial_fd)
                os.close(serial_fd)
            except Exception:
                pass
            serial_fd = None

def open_serial(serial_path=SERIAL_PATH):
    global serial_fd, running_loop
    if os.path.exists(serial_path):
        try:
            serial_fd = os.open(serial_path, os.O_RDWR | os.O_NONBLOCK)
            logging.info(f"[Bridge] Opened virtual serial device at {serial_path}")
            running_loop = asyncio.get_running_loop()
            running_loop.add_reader(serial_fd, on_serial_readable)
            return True
        except Exception as e:
            logging.error(f"[Bridge Error] Could not open {serial_path}: {e}")
    else:
        logging.info(f"[Bridge] {serial_path} does not exist yet. Will keep monitoring...")
    return False

async def monitor_serial(serial_path=SERIAL_PATH):
    global serial_fd
    while True:
        if serial_fd is None:
            open_serial(serial_path)
        await asyncio.sleep(2)

async def main(host=HOST, port=PORT, serial_path=SERIAL_PATH):
    global running_loop
    running_loop = asyncio.get_running_loop()
    logging.info(f"Starting Klipper Web Bridge Server on ws://{host}:{port} ...")
    open_serial(serial_path)

    server = await asyncio.start_server(handle_client, host, port)
    logging.info(f"WebSocket bridge server running on ws://{host}:{port}")

    asyncio.create_task(monitor_serial(serial_path))

    async with server:
        await server.serve_forever()

_bridge_thread = None

def run_bridge_thread(host=HOST, port=PORT, serial_path=SERIAL_PATH):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main(host, port, serial_path))
    except Exception as e:
        logging.error(f"[Bridge Error] {e}")

def start_web_bridge(host=HOST, port=PORT, serial_path=SERIAL_PATH):
    global _bridge_thread
    if _bridge_thread is not None and _bridge_thread.is_alive():
        return
    _bridge_thread = threading.Thread(
        target=run_bridge_thread,
        args=(host, port, serial_path),
        daemon=True,
        name="WebBridgeThread"
    )
    _bridge_thread.start()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("\nShutting down bridge server.")
