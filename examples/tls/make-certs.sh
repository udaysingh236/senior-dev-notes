#!/usr/bin/env bash
# Creates a small private PKI for the TLS examples, in ./certs (git-ignored).
#
#   root CA  ->  intermediate CA  ->  server.pem      localhost, valid 90 days
#                                 ->  expired.pem     localhost, expired on 1 April 2026
#                                 ->  wrongname.pem   payments.internal only
#                                 ->  orders.pem      client cert, spiffe://shop.internal/orders
#                                 ->  reports.pem     client cert, spiffe://shop.internal/reports
#   rogue CA ->  rogue.pem        localhost, from a CA nobody trusts (the impostor)
#
# TEST ONLY. These keys protect nothing; never use them outside these examples.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # stop Git Bash on Windows rewriting "/CN=..." into a file path

cd "$(dirname "$0")"
rm -rf certs && mkdir -p certs && cd certs

key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key" 2>/dev/null; }

# Extensions for each kind of certificate.
cat > ext.cnf <<'EOF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid

[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
authorityKeyIdentifier = keyid

[wrongname]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:payments.internal
authorityKeyIdentifier = keyid

[orders]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = URI:spiffe://shop.internal/orders

[reports]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = URI:spiffe://shop.internal/reports
EOF

# 1. The root CA: self-signed, the thing clients choose to trust.
key root
openssl req -new -x509 -key root.key -out root.pem -days 3650 \
  -subj "/O=Senior Dev Notes/CN=SDN Test Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. The intermediate CA, signed by the root. It signs everything below.
key intermediate
openssl req -new -key intermediate.key -subj "/O=Senior Dev Notes/CN=SDN Test Issuing CA 1" -out intermediate.csr
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial \
  -days 1825 -extfile ext.cnf -extensions intermediate -out intermediate.pem 2>/dev/null

# 3. Leaf certificates signed by the intermediate.
sign() { # name, extensions section, days
  openssl x509 -req -in "$1.csr" -CA intermediate.pem -CAkey intermediate.key -CAcreateserial \
    -days "$3" -extfile ext.cnf -extensions "$2" -out "$1.pem" 2>/dev/null
}
key server
openssl req -new -key server.key -subj "/CN=localhost" -out server.csr
sign server server 90
cat server.pem intermediate.pem > server-fullchain.pem   # what a server should send

openssl req -new -key server.key -subj "/CN=payments.internal" -out wrongname.csr
sign wrongname wrongname 90
cat wrongname.pem intermediate.pem > wrongname-fullchain.pem

for svc in orders reports; do
  key "$svc"
  openssl req -new -key "$svc.key" -subj "/O=shop/CN=$svc" -out "$svc.csr"
  sign "$svc" "$svc" 1
  cat "$svc.pem" intermediate.pem > "$svc-fullchain.pem"
done

# 4. An expired certificate. "openssl ca" is the tool that lets us set the dates explicitly.
mkdir -p ca-db && : > ca-db/index.txt && echo 1000 > ca-db/serial
cat > ca.cnf <<'EOF'
[ca]
default_ca = issuing
[issuing]
database = ca-db/index.txt
serial = ca-db/serial
new_certs_dir = ca-db
certificate = intermediate.pem
private_key = intermediate.key
default_md = sha256
policy = anything
copy_extensions = none
[anything]
commonName = supplied
EOF
openssl ca -batch -notext -config ca.cnf -in server.csr -out expired.pem \
  -startdate 20260101000000Z -enddate 20260401000000Z -extfile ext.cnf -extensions server 2>/dev/null
cat expired.pem intermediate.pem > expired-fullchain.pem

# 5. The impostor: a CA the attacker made, issuing a perfectly formed cert for localhost.
key rogue-root
openssl req -new -x509 -key rogue-root.key -out rogue-root.pem -days 3650 -subj "/CN=Totally Legit Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign"
key rogue
openssl req -new -key rogue.key -subj "/CN=localhost" -out rogue.csr
openssl x509 -req -in rogue.csr -CA rogue-root.pem -CAkey rogue-root.key -CAcreateserial \
  -days 90 -extfile ext.cnf -extensions server -out rogue.pem 2>/dev/null

rm -f ./*.csr ./*.srl
echo "Created in $(pwd):"
for c in root intermediate server expired wrongname rogue orders reports; do
  printf '  %-17s %s\n' "$c.pem" "$(openssl x509 -in "$c.pem" -noout -subject -enddate | tr '\n' ' ')"
done
