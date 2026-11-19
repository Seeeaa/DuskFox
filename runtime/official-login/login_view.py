"""Local-only presentation of the official QQ login surface."""
import base64
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import socketserver
import subprocess
import time
from urllib.parse import urlsplit

import pyatspi
from gi.repository import Gdk


REFRESH = {"刷新", "刷新二维码", "重新获取二维码", "点击刷新二维码", "二维码已失效，点击刷新", "Refresh QR code"}
QR = {"二维码", "登录二维码", "扫码登录二维码", "QR code", "Login QR code"}
SCANNED = {"已扫码", "请在手机上确认登录", "请在手机 QQ 上确认登录"}


def official_account():
    base = Path.home() / ".config/QQ"
    markers = [item.name[1:] for item in (base / "global/nt_data/Login").glob(".*")
               if re.fullmatch(r"\.[1-9]\d{4,11}", item.name)]
    for proc in Path("/proc").glob("[0-9]*"):
        if not is_qq_process(proc.name):
            continue
        try:
            for descriptor in (proc / "fd").iterdir():
                try:
                    target = os.readlink(descriptor)
                except OSError:
                    continue
                if re.fullmatch(re.escape(str(base)) + r"/nt_qq_[0-9a-f]+/nt_db/nt_msg\.db", target):
                    return {"state": "authorized", "uin": markers[0] if len(markers) == 1 else ""}
        except OSError:
            continue
    return {"state": "unknown"}


def is_qq_process(pid):
    if not str(pid).isdigit():
        return False
    exe = os.path.realpath("/proc/%s/exe" % pid).casefold()
    return exe.startswith("/opt/qq/") and os.path.basename(exe) == "qq"


def controls():
    desktop = pyatspi.Registry.getDesktop(0)
    found = {"qr": [], "refresh": [], "scanned": [], "login_window": []}
    for app in desktop:
        try:
            if not is_qq_process(app.get_process_id()):
                continue
        except Exception:
            continue
        for window in app:
            if not window.getState().contains(pyatspi.STATE_ACTIVE):
                continue
            queue = collections.deque([window])
            login = False
            remaining = 750
            while queue and remaining:
                node = queue.popleft()
                remaining -= 1
                try:
                    queue.extend(node.getChildAtIndex(index) for index in range(min(node.childCount, remaining, 100)))
                    if not node.getState().contains(pyatspi.STATE_SHOWING):
                        continue
                    name = (node.name or "").strip()
                    role = node.getRole()
                    if name in {"扫码登录", "使用手机QQ扫码登录", "请使用手机QQ扫码登录", "Scan to log in"}:
                        login = True
                    if name in QR and role == pyatspi.ROLE_IMAGE:
                        found["qr"].append(node)
                    elif name in REFRESH and role in (pyatspi.ROLE_PUSH_BUTTON, pyatspi.ROLE_LINK) and (name != "刷新" or login):
                        found["refresh"].append(node)
                    elif name in SCANNED:
                        found["scanned"].append(node)
                except Exception:
                    continue
            if login:
                found["login_window"].append(window)
    return found


def login_url(text):
    try:
        address = urlsplit(text)
        return address.scheme in {"https", "http"} and address.netloc == "txz.qq.com" and address.path == "/p" and bool(address.query)
    except ValueError:
        return False


def foreground_code():
    import cv2
    import numpy
    def query(*args):
        return subprocess.check_output(["xdotool", *args], timeout=1, stderr=subprocess.DEVNULL, text=True).strip()
    try:
        window_id = query("getactivewindow")
        if not window_id.isdigit() or not is_qq_process(query("getwindowpid", window_id)):
            return None
        geometry = dict(line.split("=", 1) for line in query("getwindowgeometry", "--shell", window_id).splitlines() if "=" in line)
        left, top, width, height = (int(geometry[key]) for key in ("X", "Y", "WIDTH", "HEIGHT"))
        root = Gdk.get_default_root_window()
        if not root or not (0 <= left < root.get_width() and 0 <= top < root.get_height()):
            return None
        width, height = min(root.get_width()-left, width), min(root.get_height()-top, height)
        if not (75 <= width <= 2048 and 75 <= height <= 1600):
            return None
        shot = Gdk.pixbuf_get_from_window(root, left, top, width, height)
        if not shot or query("getactivewindow") != window_id:
            return None
        channels = shot.get_n_channels()
        pixels = numpy.ndarray((height,width,channels),dtype=numpy.uint8,buffer=shot.get_pixels(),strides=(shot.get_rowstride(),channels,1))
        from pyzbar.pyzbar import decode, ZBarSymbol
        matches = [symbol for symbol in decode(cv2.cvtColor(pixels,cv2.COLOR_RGB2GRAY), symbols=[ZBarSymbol.QRCODE])
                   if login_url(symbol.data.decode("utf-8", "replace"))]
        if len(matches) != 1:
            return None
        x_pos,y_pos,extent,tall = matches[0].rect
        pad = max(6,extent//12)
        if not (65 <= extent <= 440 and abs(extent-tall) <= 12):
            return None
        x_pos,y_pos = max(0,x_pos-pad),max(0,y_pos-pad)
        return shot.new_subpixbuf(x_pos,y_pos,min(width-x_pos,extent+2*pad),min(height-y_pos,tall+2*pad))
    except (OSError, subprocess.SubprocessError, KeyError, ValueError):
        return None


def frame():
    try:
        found = controls()
    except Exception:
        found = {"scanned": [], "qr": [], "login_window": []}
    if found["scanned"]:
        return {"state": "scanned", "hint": "已扫码，请在手机 QQ 确认。"}
    root = Gdk.get_default_root_window()
    pixbuf = None
    if root and len(found["qr"]) == 1:
        rect = found["qr"][0].queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if (72 <= rect.width <= 420 and abs(rect.width - rect.height) <= 8 and rect.x >= 0 and rect.y >= 0
                and rect.x + rect.width <= root.get_width() and rect.y + rect.height <= root.get_height()):
            pixbuf = Gdk.pixbuf_get_from_window(root, rect.x, rect.y, rect.width, rect.height)
    if pixbuf is None and root and len(found["login_window"]) == 1:
        import cv2
        import numpy
        rect = found["login_window"][0].queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if (rect.x >= 0 and rect.y >= 0 and 0 < rect.width <= root.get_width() - rect.x
                and 0 < rect.height <= root.get_height() - rect.y):
            window = Gdk.pixbuf_get_from_window(root, rect.x, rect.y, rect.width, rect.height)
            if window:
                width, height = rect.width, rect.height
                channels, stride = window.get_n_channels(), window.get_rowstride()
                rgb = numpy.ndarray((height, width, channels), dtype=numpy.uint8, buffer=window.get_pixels(),
                                    strides=(stride, channels, 1))
                detected, corners = cv2.QRCodeDetector().detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))
                if detected:
                    left, top, extent, tall = cv2.boundingRect(corners)
                    if 72 <= extent <= 420 and abs(extent - tall) <= 10:
                        margin = max(6, extent // 12)
                        left, top = max(0, left-margin), max(0, top-margin)
                        pixbuf = window.new_subpixbuf(left, top, min(width-left, extent+2*margin), min(height-top, tall+2*margin))
    if pixbuf is None:
        pixbuf = foreground_code()
    if pixbuf is None:
        return {"state": "unavailable", "hint": "未发现登录二维码。", "needsWindow": True}
    ok, png = pixbuf.save_to_bufferv("png", [], [])
    if not ok:
        raise RuntimeError("frame unavailable")
    return {"state": "waiting", "image": "data:image/png;base64," + base64.b64encode(png).decode(),
            "seq": int.from_bytes(hashlib.sha256(png).digest()[:5], "big"), "hint": "使用手机 QQ 扫码确认。"}


class Request(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(2)
        try:
            action = self.rfile.readline(64).strip()
            if action == b"account":
                result = official_account()
            elif action in (b"frame", b"refresh") and official_account()["state"] == "authorized":
                result = {"state": "confirmed", "hint": "已登录"}
            elif action == b"refresh":
                try:
                    found = controls()["refresh"]
                except Exception:
                    found = []
                if len(found) != 1:
                    result = frame()
                    if result["state"] == "unavailable":
                        result["hint"] = "请在官方 QQ 窗口选择扫码登录或刷新。"
                    elif result["state"] == "waiting":
                        result["hint"] = "已读取当前二维码，请用手机 QQ 扫码。"
                elif time.monotonic() - self.server.last_refresh < 2:
                    result = frame()
                else:
                    self.server.last_refresh = time.monotonic()
                    target = found[0].queryAction()
                    actions = [index for index in range(target.nActions) if target.getName(index).casefold() in {"click", "press", "activate"}] if target.nActions != 1 else [0]
                    if len(actions) != 1 or not target.doAction(actions[0]):
                        raise RuntimeError("refresh unavailable")
                    result = {"state": "pending", "hint": "已请求官方 QQ 刷新二维码。"}
            elif action == b"frame":
                result = frame()
            else:
                result = {"error": "unknown action"}
        except Exception as error:
            result = {"state": "unavailable", "hint": type(error).__name__ + ": " + str(error)}
        self.wfile.write(json.dumps(result).encode() + b"\n")


if __name__ == "__main__":
    os.umask(0o077)
    path = "/run/df-view/login.sock"
    with socketserver.UnixStreamServer(path, Request) as server:
        server.last_refresh = float("-inf")
        server.serve_forever()
