# Troubleshooting: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / cert errors (Windows)

If `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or sign-in fails with
`request to https://www.googleapis.com/oauth2/v1/certs failed ... unable to verify the
first certificate`, then **antivirus or a corporate proxy is intercepting HTTPS** on your
machine and presenting a certificate Node doesn't trust by default.

Fix: export the certificates your OS already trusts into a PEM bundle and point Node at
it via `NODE_EXTRA_CA_CERTS`.

```powershell
# 1. Export the Windows trust store (includes the AV/proxy root) to a PEM bundle
$out = "$PWD\certs\ca-bundle.pem"
New-Item -ItemType Directory -Force certs | Out-Null
$certs = Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root
$sb = New-Object System.Text.StringBuilder
foreach ($c in $certs) {
  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")
  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData,'InsertLineBreaks'))
  [void]$sb.AppendLine("-----END CERTIFICATE-----")
}
[System.IO.File]::WriteAllText($out, $sb.ToString())

# 2. Make every local Node process trust it (persists; restart the terminal after)
setx NODE_EXTRA_CA_CERTS "$out"
```

`certs/` is git-ignored, so this machine-specific bundle never reaches your server (which
won't have the interception and doesn't need it). To undo: delete the env var with
`setx NODE_EXTRA_CA_CERTS ""` (or remove it in *Environment Variables*). The cleaner
long-term fix is to disable HTTPS/SSL scanning for these hosts in your antivirus.

> `setx` only affects **new** processes — restart your terminal (and the IDE) once before
> running `npm run dev`.

## Deploying to Fly behind the same interceptor

`flyctl` is a Go binary and ignores `NODE_EXTRA_CA_CERTS`, and Fly's "Depot" builder uses
a TLS/gRPC channel the interceptor breaks (`x509: certificate signed by unknown
authority`). Two fixes, both already applied: point Go at the same bundle and skip Depot.

```powershell
setx SSL_CERT_FILE "$PWD\certs\ca-bundle.pem"   # Go reads this; restart terminal after
npm run deploy                                   # = fly deploy --depot=false
```
