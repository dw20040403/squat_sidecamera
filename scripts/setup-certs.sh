#!/usr/bin/env bash
# mkcertでローカル証明書を作成し、iPhoneにルート証明書を入れる手順を表示する
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert が見つかりません。Macでは: brew install mkcert nss" >&2
  exit 1
fi

mkdir -p certs
mkcert -install

# LANのIPアドレス（macOSとLinux）
IPS=$( (ipconfig getifaddr en0 2>/dev/null; ipconfig getifaddr en1 2>/dev/null; hostname -I 2>/dev/null) | tr ' ' '\n' | grep -E '^[0-9.]+$' | sort -u || true)
HOSTS="localhost 127.0.0.1 ::1 $(hostname) ${IPS} $*"
echo "証明書の対象: ${HOSTS}"
# shellcheck disable=SC2086
mkcert -cert-file certs/cert.pem -key-file certs/key.pem ${HOSTS}

CAROOT=$(mkcert -CAROOT)
cp "${CAROOT}/rootCA.pem" certs/rootCA.pem

cat <<MSG

証明書を certs/ に作成しました（gitの管理対象外）。
MacのIPアドレスが変わったら、もう一度このスクリプトを実行してください（追加のホスト名は引数で渡せます）。

■ iPhoneにルート証明書を入れる手順（2台とも）
  1. certs/rootCA.pem をAirDropでiPhoneに送る（またはメールで送って開く）
  2. 「設定 → 一般 → VPNとデバイス管理」でプロファイルをインストールする
  3. 「設定 → 一般 → 情報 → 証明書信頼設定」で mkcert のルート証明書の信頼をオンにする
  4. Safariで https://<MacのIP>:8443/?role=main が警告なしで開けることを確認する

MSG
