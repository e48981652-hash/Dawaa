#!/bin/sh
cd "$(dirname "$0")" || exit 1
[ -f .env ] || cp .env.example .env
NODE_BIN=node
[ -x ./node/bin/node ] && NODE_BIN=./node/bin/node
if ! "$NODE_BIN" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" 2>/dev/null; then
  echo "لم نجد Node.js بالنسخة المطلوبة (22 أو أحدث)."
  echo "نزّل النسخة المضغوطة من https://nodejs.org/en/download وفكّها داخل هذا المجلد باسم node"
  exit 1
fi
echo "التطبيق يعمل على http://localhost:3000"
( sleep 1; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
exec "$NODE_BIN" --disable-warning=ExperimentalWarning server.js
