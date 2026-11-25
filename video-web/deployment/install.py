"""Install this viewer's socket-activated LaunchAgent and the homelab route."""
import argparse
import os
import plistlib
import shutil
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--idle-ms", type=int, default=1200000)
    parser.add_argument("--library-url", default="http://127.0.0.1:3001")
    args = parser.parse_args()
    if args.idle_ms < 1000:
        parser.error("idle-ms 至少为 1000")
    root = Path(__file__).resolve().parent.parent
    deployment = root / "deployment"
    homelab = Path.home() / "homelab"
    node = shutil.which("node")
    if not node or not (homelab / "configs/web/homelabctl.py").is_file():
        raise RuntimeError("需要本机 Node.js 和 ~/homelab/configs/web/homelabctl.py")
    subprocess.run(["cc", "-O2", "-Wall", "-Wextra", str(deployment / "launchd-socket.c"),
                    "-o", str(deployment / "launchd-socket")], check=True)
    label = "com.zq.douyin-video"
    agent = Path.home() / "Library/LaunchAgents" / (label + ".plist")
    route = homelab / "configs/web/routes/douyin.caddy"
    route_content = (deployment / "douyin.caddy").read_bytes()
    if route.exists() and route.read_bytes() != route_content:
        raise RuntimeError("已有不同的 douyin.caddy，请先检查，安装器不会覆盖")
    config = {
        "Label": label,
        "ProgramArguments": [str(deployment / "launchd-socket"), node, str(root / "server.mjs")],
        "WorkingDirectory": str(root),
        "ProcessType": "Background",
        "EnvironmentVariables": {"HOST": "127.0.0.1", "PORT": "3002",
                                 "IDLE_MS": str(args.idle_ms), "LIBRARY_URL": args.library_url},
        "Sockets": {"Listener": {"SockFamily": "IPv4", "SockNodeName": "127.0.0.1",
                                 "SockServiceName": "3002"}},
        "StandardOutPath": str(deployment / "launchd.log"),
        "StandardErrorPath": str(deployment / "launchd-error.log"),
    }
    # Only replace this application's own agent. Existing library/music services are untouched.
    service = "gui/{}/{}".format(os.getuid(), label)
    present = subprocess.run(["launchctl", "print", service], capture_output=True).returncode == 0
    if present:
        subprocess.run(["launchctl", "bootout", service], check=True)
        for _ in range(20):
            if subprocess.run(["launchctl", "print", service], capture_output=True).returncode != 0:
                break
            time.sleep(0.2)
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_bytes(plistlib.dumps(config))
    subprocess.run(["plutil", "-lint", str(agent)], check=True)
    subprocess.run(["launchctl", "enable", service], check=True)
    subprocess.run(["launchctl", "bootstrap", "gui/{}".format(os.getuid()), str(agent)], check=True)
    route.write_bytes(route_content)
    subprocess.run(["python3", str(homelab / "configs/web/homelabctl.py"), "reload-caddy"],
                   cwd=str(homelab), check=True)
    print("已部署 https://douyin.home.zqzyz.com；空闲 {} 秒退出".format(args.idle_ms // 1000))


if __name__ == "__main__":
    main()
