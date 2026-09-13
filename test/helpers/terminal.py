"""Drive a real terminal through agentbox and SSH, including a window resize."""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])


def resize(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


resize(31, 97)
output = b""
resized = False
try:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            if b"RESIZE_READY" in output and not resized:
                resize(47, 111)
                # The foreground process receives SIGWINCH from the PTY.
                time.sleep(0.2)
                os.write(master, b"continue\n")
                resized = True
    else:
        raise TimeoutError("terminal test timed out")
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(master)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
