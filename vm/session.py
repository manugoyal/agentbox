"""Short-lived credential handoff in guest RAM; SSH carries the actual terminal."""
import json
import os
import re
import stat
import sys
import time
import uuid

LIMIT = 1024 * 1024
TTL = 300
BASE = f"/dev/shm/agentbox-{os.getuid()}"


def base_directory():
    try:
        os.mkdir(BASE, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(BASE)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("unsafe session directory")


def ticket_path(ticket):
    if not re.fullmatch(r"[a-f0-9]{32}", ticket):
        raise ValueError("invalid session ticket")
    return os.path.join(BASE, ticket)


def validate(request):
    if not isinstance(request, dict) or set(request) != {"argv", "env"}:
        raise ValueError("invalid request")
    argv = request["argv"]
    if not isinstance(argv, list) or not argv or not argv[0] or not all(isinstance(arg, str) and "\0" not in arg for arg in argv):
        raise ValueError("invalid argv")
    env = request["env"]
    if not isinstance(env, dict) or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) and isinstance(value, str) and "\0" not in value for key, value in env.items()):
        raise ValueError("invalid environment")
    return request


def main():
    base_directory()
    mode = sys.argv[1]
    if mode == "stage":
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError("request too large")
        validate(json.loads(raw))
        # Reap abandoned handoffs from interrupted host launchers.
        for name in os.listdir(BASE):
            if re.fullmatch(r"[a-f0-9]{32}", name):
                path = ticket_path(name)
                try:
                    if time.time() - os.lstat(path).st_mtime > TTL:
                        os.unlink(path)
                except FileNotFoundError:
                    pass
        ticket = uuid.uuid4().hex
        descriptor = os.open(ticket_path(ticket), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
        print(ticket)
        return
    path = ticket_path(sys.argv[2])
    if mode == "discard":
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    if mode != "run":
        raise ValueError("invalid session operation")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or time.time() - info.st_mtime > TTL:
            raise ValueError("unsafe or expired session")
        with os.fdopen(descriptor, "rb") as source:
            request = validate(json.loads(source.read(LIMIT + 1)))
    finally:
        os.unlink(path)
    # Guest HOME/PATH and normal guest environment stay intact. The host's
    # environment, credential stores and authentication agents are not imported.
    environment = dict(os.environ)
    environment.update(request["env"])
    os.chdir(os.path.expanduser("~"))
    os.execvpe(request["argv"][0], request["argv"], environment)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Payloads can contain secrets; do not print exception values or a trace.
        print(f"agentbox: guest session failed ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
