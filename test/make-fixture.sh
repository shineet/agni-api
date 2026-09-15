#!/bin/bash
# Regenerates the test certificates. Run only if they expire or the extension
# structure needs changing; the outputs are committed so `node --test` needs no
# openssl.
set -euo pipefail
cd "$(dirname "$0")"
NONCE=$(python3 -c "print('AB'*32)")
EXT=$(python3 - <<PY
nonce = bytes.fromhex("$NONCE")
inner  = b'\x04\x20' + nonce
tagged = b'\xa1' + bytes([len(inner)]) + inner
seq    = b'\x30' + bytes([len(tagged)]) + tagged
print(seq.hex().upper())
PY
)
cat > /tmp/agni-ext.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Agni DER parser fixture
[v3]
1.2.840.113635.100.8.2 = DER:$EXT
CNF
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout /dev/null -out fixture-nonce-cert.pem -days 36500 -config /tmp/agni-ext.cnf 2>/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout /dev/null -out fixture-plain-cert.pem -days 36500 -subj "/CN=Agni plain fixture" 2>/dev/null
echo "fixtures regenerated"
