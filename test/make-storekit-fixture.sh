#!/bin/bash
# A stand-in App Store signing chain for the StoreKit verification tests:
# a root, an intermediate carrying Apple's WWDR marker OID, a leaf carrying
# the App Store marker OID, a second leaf WITHOUT it, and a third whose
# marker bytes are PLANTED inside an unrelated extension (the hole a raw-byte
# search for the OID could not see). Same shape as
# Apple's chain, none of Apple's keys. Outputs are committed so `node --test`
# needs no openssl. TEST KEYS ONLY: nothing in production trusts this root.
set -euo pipefail
cd "$(dirname "$0")/fixtures/storekit"
cat > ca.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Agni test root
[root]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.11.1 = ASN1:NULL
[plantedleaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.3.4 = DER:060a2a864886f76364060b01
[plainleaf]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
for k in root intermediate leaf plainleaf plantedleaf; do
  openssl ecparam -name prime256v1 -genkey -noout -out $k.key 2>/dev/null
done
openssl req -x509 -new -key root.key -subj "/CN=Agni test root" -days 3650 \
  -config ca.cnf -extensions root -out root.pem
openssl req -new -key intermediate.key -subj "/CN=Agni test intermediate" -out intermediate.csr
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial \
  -days 3650 -extfile ca.cnf -extensions intermediate -out intermediate.pem 2>/dev/null
for k in leaf plainleaf plantedleaf; do
  openssl req -new -key $k.key -subj "/CN=Agni test $k" -out $k.csr
  openssl x509 -req -in $k.csr -CA intermediate.pem -CAkey intermediate.key -CAcreateserial \
    -days 3650 -extfile ca.cnf -extensions $k -out $k.pem 2>/dev/null
done
rm -f *.csr *.srl ca.cnf
echo "storekit fixtures regenerated"
