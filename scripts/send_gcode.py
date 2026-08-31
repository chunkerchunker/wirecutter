#!/usr/bin/env python3

import argparse
import serial
import time
import sys
import os

def format_time(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"

def main():
    parser = argparse.ArgumentParser(description="Send a G-code file to a 3D printer over serial.")
    parser.add_argument("file", help="Path to the G-code file")
    parser.add_argument("--port", default="/tmp/printer", help="Serial port (default: /tmp/printer)")
    parser.add_argument("--baudrate", type=int, default=250000, help="Baud rate (default: 250000)")
    parser.add_argument("--no-home", action="store_true", help="Suppress homing (G28) before sending")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"Error: File '{args.file}' not found.")
        sys.exit(1)

    # Read and filter gcode lines
    gcode_lines = []
    with open(args.file, "r") as f:
        for line in f:
            # Strip comments and whitespace
            l = line.split(';')[0].strip()
            if l:
                gcode_lines.append(l)

    if not args.no_home:
        gcode_lines.insert(0, "G28")

    total_lines = len(gcode_lines)
    if total_lines == 0:
        print("No valid G-code commands found in file.")
        sys.exit(0)

    try:
        ser = serial.Serial(args.port, args.baudrate, timeout=1)
    except serial.SerialException as e:
        print(f"Error opening serial port {args.port}: {e}")
        sys.exit(1)

    print(f"Opened {args.port}. Sending {total_lines} commands...")

    start_time = time.time()
    
    # Send a newline to clear any pending partial commands
    ser.write(b"\n")
    time.sleep(0.1)
    ser.reset_input_buffer()

    try:
        for idx, cmd in enumerate(gcode_lines, 1):
            command_bytes = (cmd + "\n").encode('utf-8')
            ser.write(command_bytes)
            
            # Wait for ok
            while True:
                response_bytes = ser.readline()
                if not response_bytes:
                    continue
                
                response = response_bytes.decode('utf-8', errors='replace').strip()
                if response.startswith("ok"):
                    break
                elif response:
                    # Clear current line and print printer response
                    sys.stdout.write(f"\r\033[K[Printer] {response}\n")
                    sys.stdout.flush()

            # Update progress
            elapsed = time.time() - start_time
            progress = idx / total_lines
            eta = (elapsed / progress) - elapsed if progress > 0 else 0
            
            bar_len = 30
            filled = int(bar_len * progress)
            bar = '=' * filled + '-' * (bar_len - filled)
            sys.stdout.write(f"\rProgress: [{bar}] {idx}/{total_lines} ({progress*100:.1f}%) | Elapsed: {format_time(elapsed)} | ETA: {format_time(eta)}")
            sys.stdout.flush()
            
    except KeyboardInterrupt:
        print("\n\nAborted by user.")
    finally:
        print("\nClosing serial port.")
        ser.close()

if __name__ == "__main__":
    main()
