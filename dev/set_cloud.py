# -*- coding: utf-8 -*-
"""同期先（Supabase）の既定値を index.html に焼き込む。

  python dev/set_cloud.py https://xxxx.supabase.co eyJhbGciOi...
  python dev/set_cloud.py --clear          # 既定値を空に戻す

anon キーは公開前提の値で、実際の保護は行レベルセキュリティが行う。
既定値を入れておくと、利用者はURLとキーを打たずに、登録・ログインだけで使える。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "index.html"
PATTERN = re.compile(r"const CLOUD_DEFAULT = \{ url: '[^']*', anonKey: '[^']*' \};")


def apply(url: str, key: str) -> None:
    text = INDEX.read_text(encoding="utf-8")
    if not PATTERN.search(text):
        raise SystemExit("index.html に CLOUD_DEFAULT が見つからない")
    line = f"const CLOUD_DEFAULT = {{ url: '{url}', anonKey: '{key}' }};"
    INDEX.write_text(PATTERN.sub(lambda _m: line, text, count=1), encoding="utf-8", newline="\n")
    print("index.html を更新")


def main() -> None:
    args = sys.argv[1:]
    if args == ["--clear"]:
        apply("", "")
        print("同期先の既定値を空に戻した（アプリ内の「接続先の設定」から入力する形になる）")
        return
    if len(args) != 2:
        raise SystemExit(__doc__)
    url, key = args[0].rstrip("/"), args[1].strip()
    if not url.startswith("https://"):
        raise SystemExit("プロジェクトURLは https:// で始まる必要がある")
    if "'" in url or "'" in key:
        raise SystemExit("値にシングルクォートは使えない")
    if len(key) < 20:
        raise SystemExit("anon キーが短すぎる。service_role ではなく anon public を使う")
    if "service_role" in key:
        raise SystemExit("service_role キーは絶対に埋め込まない。anon public を使う")
    apply(url, key)
    print(f"\n同期先を {url} に設定した。次に:")
    print("  1. supabase/schema.sql を Supabase の SQL Editor で実行する（まだなら）")
    print("  2. Authentication → URL Configuration に公開URLを登録する（CLOUD_SETUP.md の 4）")
    print("  3. index.html をコミットして公開する")


if __name__ == "__main__":
    main()
