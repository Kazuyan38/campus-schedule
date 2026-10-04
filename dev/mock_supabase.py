# -*- coding: utf-8 -*-
"""Supabase と同じ形の応答を返す検証用サーバ。

本物のプロジェクトが無くても、アプリ側の通信経路（CORS のプリフライト、Bearer の付与、
401 からの更新、rev による楽観ロック、競合時の 0 件応答、メール確認、アカウント削除）を
端から端まで確かめるために使う。保存は全てメモリ上で、終了すれば消える。

  python dev/mock_supabase.py [ポート番号] [--confirm]

--confirm を付けると、新規登録後にメール確認が済むまでログインできない
（Supabase の既定どおり）。確認は GET /__confirm?email=... で済ませる。
実装しているのは GoTrue と PostgREST のうち、アプリが実際に叩く経路だけ。
"""
from __future__ import annotations

import json
import re
import datetime
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ANON_KEY = "mock-anon-key"
TABLE = "/rest/v1/campus_schedules"
ACCESS_TTL = 2.0          # 秒。短くして 401 → 更新 → 再試行を起こさせる
CONFIRM = "--confirm" in sys.argv

ADMINS = {"admin@example.test"}       # 管理者ページの検証用。実物の app_admins に当たる

STATE = {
    "users": {},          # email -> {id, password, email, confirmed}
    "access": {},         # access_token -> {user_id, expires}
    "refresh": {},        # refresh_token -> user_id
    "rows": {},           # user_id -> {user_id, data, rev, updated_at, device}
    "mails": [],          # 送られたメール（再設定・確認）。検証用に覗ける
    "requests": [],       # 受けたリクエストの記録（通信が起きていないことの検証用）
}
LOCK = threading.Lock()


def issue(user_id: str) -> dict:
    access, refresh = secrets.token_hex(8), secrets.token_hex(8)
    STATE["access"][access] = {"user_id": user_id, "expires": time.time() + ACCESS_TTL}
    STATE["refresh"][refresh] = user_id
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
            "expires_in": int(ACCESS_TTL)}


def user_of(headers) -> str | None:
    auth = headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return None
    entry = STATE["access"].get(auth[7:])
    if not entry or entry["expires"] < time.time():
        return None
    return entry["user_id"]


def email_of(uid: str) -> str:
    return next((e for e, u in STATE["users"].items() if u["id"] == uid), "")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "apikey, authorization, content-type, prefer, x-client-info")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, PUT, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")

    def reply(self, status: int, payload=None):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.cors()
        if body:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode())
        except Exception:
            return {}

    def note(self):
        if self.command != "OPTIONS" and not self.path.startswith("/__"):
            STATE["requests"].append(f"{self.command} {urlparse(self.path).path}")

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        with LOCK:
            self.note()
            if path == "/auth/v1/user":
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"msg": "invalid token"})
                return self.reply(200, {"id": uid, "email": email_of(uid)})
            if path == TABLE:
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                row = STATE["rows"].get(uid)          # 行レベルセキュリティ：自分の行だけ
                return self.reply(200, [row] if row else [])
            if path == "/__state":
                return self.reply(200, {"users": len(STATE["users"]),
                                        "rows": {email_of(k): v["rev"] for k, v in STATE["rows"].items()},
                                        "mails": STATE["mails"], "requests": STATE["requests"]})
            if path == "/__row":                      # 検証用：特定ユーザーの行そのものを見る
                email = (parse_qs(parsed.query).get("email") or [""])[0]
                user = STATE["users"].get(email)
                row = STATE["rows"].get(user["id"]) if user else None
                return self.reply(200, row or {})
            if path == "/__confirm":
                email = (parse_qs(parsed.query).get("email") or [""])[0]
                user = STATE["users"].get(email)
                if not user:
                    return self.reply(404, {"message": "no such user"})
                user["confirmed"] = True
                tokens = issue(user["id"])
                return self.reply(200, {"link": f"#access_token={tokens['access_token']}"
                                                f"&refresh_token={tokens['refresh_token']}&type=signup"})
            if path == "/__reset":
                for key in ("users", "access", "refresh", "rows"):
                    STATE[key].clear()
                STATE["mails"].clear()
                STATE["requests"].clear()
                return self.reply(200, {"ok": True})
            if path == "/__clear_requests":
                STATE["requests"].clear()
                return self.reply(200, {"ok": True})
        self.reply(404, {"message": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        data = self.body()
        with LOCK:
            self.note()
            if path == "/auth/v1/signup":
                email, password = (data.get("email") or "").strip(), data.get("password") or ""
                if len(password) < 6:
                    return self.reply(422, {"msg": "Password should be at least 6 characters"})
                if email in STATE["users"]:
                    return self.reply(400, {"msg": "User already registered"})
                uid = secrets.token_hex(8)
                STATE["users"][email] = {"id": uid, "password": password, "email": email,
                                         "confirmed": not CONFIRM,
                                         "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                if CONFIRM:           # 確認が必要なプロジェクトでは、トークンは返らない
                    STATE["mails"].append({"email": email, "kind": "confirm"})
                    return self.reply(200, {"id": uid, "email": email})
                out = issue(uid)
                out["user"] = {"id": uid, "email": email}
                return self.reply(200, out)

            if path == "/auth/v1/token":
                grant = (query.get("grant_type") or [""])[0]
                if grant == "password":
                    user = STATE["users"].get((data.get("email") or "").strip())
                    if not user or user["password"] != data.get("password"):
                        return self.reply(400, {"error_description": "Invalid login credentials"})
                    if not user["confirmed"]:
                        return self.reply(400, {"error_description": "Email not confirmed"})
                    out = issue(user["id"])
                    out["user"] = {"id": user["id"], "email": user["email"]}
                    return self.reply(200, out)
                if grant == "refresh_token":
                    uid = STATE["refresh"].get(data.get("refresh_token"))
                    if not uid:
                        return self.reply(400, {"error_description": "Invalid Refresh Token"})
                    out = issue(uid)
                    out["user"] = {"id": uid, "email": email_of(uid)}
                    return self.reply(200, out)
                return self.reply(400, {"error_description": "unsupported grant"})

            if path == "/auth/v1/recover":
                email = (data.get("email") or "").strip()
                user = STATE["users"].get(email)
                if user:
                    tokens = issue(user["id"])
                    STATE["mails"].append({
                        "email": email, "kind": "recovery",
                        "link": (data.get("redirect_to") or "") +
                                f"#access_token={tokens['access_token']}"
                                f"&refresh_token={tokens['refresh_token']}&type=recovery",
                    })
                return self.reply(200, {})        # 実物と同じく、宛先の存在は伏せて常に成功

            if path == "/auth/v1/logout":
                return self.reply(204)

            if path.startswith("/rest/v1/rpc/") and path.split("/")[-1] in (
                    "is_admin", "admin_overview", "admin_users", "admin_delete_user"):
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                name = path.split("/")[-1]
                me = email_of(uid)
                if name == "is_admin":
                    return self.reply(200, me in ADMINS)
                if me not in ADMINS:
                    return self.reply(403, {"code": "42501", "message": "forbidden"})
                now = datetime.datetime.now(datetime.timezone.utc)
                if name == "admin_overview":
                    rows = list(STATE["rows"].values())
                    def day(i):
                        return (now - datetime.timedelta(days=13 - i)).date().isoformat()
                    def n_on(items, key, d):
                        return sum(1 for x in items if str(x.get(key) or "")[:10] == d)
                    users = list(STATE["users"].values())
                    return self.reply(200, {
                        "users_total": len(users), "rows_total": len(rows),
                        "active_7d": len(rows), "signups_7d": len(users),
                        "data_bytes": sum(len(json.dumps(r.get("data"))) for r in rows),
                        "db_bytes": 9_400_000,
                        "last_activity": now.isoformat(),
                        "signups_daily": [{"d": day(i), "n": n_on(users, "created_at", day(i))} for i in range(14)],
                        "active_daily": [{"d": day(i), "n": n_on(rows, "updated_at", day(i))} for i in range(14)],
                    })
                if name == "admin_users":
                    out = []
                    for u in STATE["users"].values():
                        r = STATE["rows"].get(u["id"]) or {}
                        courses = (r.get("data") or {}).get("courses") or []
                        out.append({"user_id": u["id"], "email": u["email"], "created_at": u["created_at"],
                                    "last_sign_in_at": None, "updated_at": r.get("updated_at"), "rev": r.get("rev"),
                                    "courses": len(courses), "bytes": len(json.dumps(r.get("data"))) if r else None,
                                    "device": r.get("device"), "is_admin": u["email"] in ADMINS})
                    return self.reply(200, out)
                target = data.get("target")
                victim = next((u for u in STATE["users"].values() if u["id"] == target), None)
                if victim and victim["email"] in ADMINS:
                    return self.reply(403, {"code": "42501", "message": "cannot delete an admin"})
                if victim:
                    STATE["users"].pop(victim["email"], None)
                    STATE["rows"].pop(victim["id"], None)
                return self.reply(204)

            if path == "/rest/v1/rpc/delete_my_account":
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                email = email_of(uid)
                STATE["users"].pop(email, None)
                STATE["rows"].pop(uid, None)      # on delete cascade
                # 実物と同じく、削除したアカウントのトークンは使えなくなる（ほかの端末は更新に失敗する）
                for k in [k for k, v in STATE["access"].items() if v["user_id"] == uid]:
                    del STATE["access"][k]
                for k in [k for k, v in STATE["refresh"].items() if v == uid]:
                    del STATE["refresh"][k]
                return self.reply(204)

            if path == TABLE:
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                if data.get("user_id") != uid:
                    return self.reply(403, {"message": "row violates row-level security policy"})
                if uid in STATE["rows"]:
                    return self.reply(409, {"message": "duplicate key value violates unique constraint"})
                STATE["rows"][uid] = dict(data)
                return self.reply(201, [STATE["rows"][uid]])
        self.reply(404, {"message": "not found"})

    def do_PUT(self):
        path = urlparse(self.path).path
        data = self.body()
        with LOCK:
            self.note()
            if path == "/auth/v1/user":
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"msg": "invalid token"})
                if "password" in data:
                    if len(data["password"]) < 6:
                        return self.reply(422, {"msg": "Password should be at least 6 characters"})
                    for user in STATE["users"].values():
                        if user["id"] == uid:
                            user["password"] = data["password"]
                return self.reply(200, {"id": uid, "email": email_of(uid)})
        self.reply(404, {"message": "not found"})

    def do_PATCH(self):
        parsed = urlparse(self.path)
        data = self.body()
        with LOCK:
            self.note()
            if parsed.path == TABLE:
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                query = parse_qs(parsed.query)
                m = re.match(r"eq\.(\d+)$", query.get("rev", ["eq.-1"])[0])
                row = STATE["rows"].get(uid)
                # 条件に合う行が無ければ 0 件。これが楽観ロックの要。
                if not row or not m or row["rev"] != int(m.group(1)):
                    return self.reply(200, [])
                row.update(data)
                return self.reply(200, [row])
        self.reply(404, {"message": "not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        with LOCK:
            self.note()
            if parsed.path == TABLE:
                uid = user_of(self.headers)
                if not uid:
                    return self.reply(401, {"message": "JWT expired"})
                STATE["rows"].pop(uid, None)
                return self.reply(204)
        self.reply(404, {"message": "not found"})


def main() -> None:
    nums = [a for a in sys.argv[1:] if a.isdigit()]
    port = int(nums[0]) if nums else 8788
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock supabase on http://127.0.0.1:{port}  anon key: {ANON_KEY}  confirm={CONFIRM}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
