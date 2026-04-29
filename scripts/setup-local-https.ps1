param(
    [string]$OutDir = "certs",
    [string]$CommonName = "TXT Reader Local CA"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$certDir = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$caCerPath = Join-Path $certDir "local-ca.cer"
$caPemPath = Join-Path $certDir "local-ca.pem"
$certPath = Join-Path $certDir "server-cert.pem"
$keyPath = Join-Path $certDir "server-key.pem"

$notBefore = [DateTimeOffset]::Now.AddMinutes(-5)
$caNotAfter = $notBefore.AddYears(10)
$serverNotAfter = $notBefore.AddYears(2)

$caKey = [System.Security.Cryptography.RSA]::Create(4096)
$caReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$CommonName",
    $caKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
        $true,
        $false,
        0,
        $true
    )
)
$caReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,
        $true
    )
)
$caReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
        $caReq.PublicKey,
        $false
    )
)
$caCert = $caReq.CreateSelfSigned($notBefore, $caNotAfter)

$serverKey = [System.Security.Cryptography.RSA]::Create(2048)
$serverReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=txt-reader.local",
    $serverKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName("localhost")
$san.AddDnsName("txt-reader.local")
$san.AddDnsName($env:COMPUTERNAME)
$san.AddDnsName("$($env:COMPUTERNAME).local")
$san.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))

$localIps = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object {
        $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
        $_.ToString() -notlike "169.254.*" -and
        $_.ToString() -ne "127.0.0.1"
    } |
    ForEach-Object { $_.ToString() } |
    Select-Object -Unique

foreach ($ip in $localIps) {
    $san.AddIpAddress([System.Net.IPAddress]::Parse($ip))
}

$serverReq.CertificateExtensions.Add($san.Build($false))
$serverReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
        $false,
        $false,
        0,
        $true
    )
)
$serverReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
        $true
    )
)
$serverUsages = [System.Security.Cryptography.OidCollection]::new()
$serverUsages.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")) | Out-Null
$serverReq.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
        $serverUsages,
        $false
    )
)

$serial = New-Object byte[] 16
[System.Security.Cryptography.RandomNumberGenerator]::Fill($serial)
$serverCert = $serverReq.Create($caCert, $notBefore, $serverNotAfter, $serial)
$serverCert = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey(
    $serverCert,
    $serverKey
)

[System.IO.File]::WriteAllBytes($caCerPath, $caCert.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
))
[System.IO.File]::WriteAllText($caPemPath, $caCert.ExportCertificatePem())
[System.IO.File]::WriteAllText($certPath, $serverCert.ExportCertificatePem())
[System.IO.File]::WriteAllText($keyPath, $serverKey.ExportPkcs8PrivateKeyPem())

Import-Certificate -FilePath $caCerPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null

Write-Host "Created:"
Write-Host "  CA certificate:     $caCerPath"
Write-Host "  CA PEM for mobile:  $caPemPath"
Write-Host "  Server certificate: $certPath"
Write-Host "  Server key:         $keyPath"
Write-Host ""
Write-Host "Trusted the CA in CurrentUser\Root for this Windows account."
Write-Host "Configure config.toml with:"
Write-Host "  tls_cert_path = `"certs/server-cert.pem`""
Write-Host "  tls_key_path = `"certs/server-key.pem`""
Write-Host ""
Write-Host "Certificate IP SANs:"
$localIps | ForEach-Object { Write-Host "  https://$($_):3000" }
