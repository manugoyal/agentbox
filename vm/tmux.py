"""Create or attach to tmux while refreshing Agentbox-injected variables."""
import json
import os
import subprocess
import sys


def run(*arguments, capture=False):
    return subprocess.run(
        ["tmux", *arguments],
        check=False,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.DEVNULL if capture else None,
        text=True,
    )


def main():
    session = sys.argv[1]
    current = json.loads(sys.argv[2])
    if not isinstance(current, list) or not all(
        isinstance(name, str) and name.isidentifier() for name in current
    ):
        raise ValueError("invalid environment names")

    target = f"={session}"
    created_pane = None
    if run("has-session", "-t", target, capture=True).returncode != 0:
        created = run(
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            session,
            capture=True,
        )
        if created.returncode != 0:
            raise RuntimeError("could not create tmux session")
        created_pane = created.stdout.strip()

    shown = run(
        "show-options",
        "-gqv",
        "@agentbox-environment-names",
        capture=True,
    )
    names = sorted(set(current + shown.stdout.split()))
    if names:
        if (
            run(
                "set-option",
                "-g",
                "@agentbox-environment-names",
                " ".join(names),
            ).returncode
            != 0
        ):
            raise RuntimeError("could not configure tmux environment")
        selected = set(current)
        for name in names:
            if (
                run("set-environment", "-g", "-r", name).returncode
                != 0
            ):
                raise RuntimeError("could not configure tmux environment")
            if name in selected:
                configured = run(
                    "set-environment", "-t", target, name, os.environ[name]
                )
            else:
                configured = run("set-environment", "-r", "-t", target, name)
            if configured.returncode != 0:
                raise RuntimeError("could not configure tmux environment")

    if created_pane and run("respawn-pane", "-k", "-t", created_pane).returncode != 0:
        raise RuntimeError("could not initialize tmux session")

    os.execvp("tmux", ["tmux", "attach-session", "-t", target])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"agentbox: tmux setup failed ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
