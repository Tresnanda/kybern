<p align="center">
  <a href="https://github.com/Tresnanda/kybern">
    <img src="assets/kybern-logo.svg" alt="Logo Kybern" width="120">
  </a>
</p>

<h1 align="center">Kybern</h1>

<p align="center">
  <b>Studio desktop multi-thread untuk coding agent otonom.</b><br>
  Kelola Claude Code, Codex, OpenCode, Cursor, dan Pi sekaligus di git worktree yang terpisah, dengan protokol native, diff terpadu, dan konteks yang tidak saling bocor.
</p>

<p align="center">
  <a href="README.md">English</a> • <b>Bahasa Indonesia</b>
</p>

<p align="center">
  <a href="https://github.com/Tresnanda/kybern/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Tresnanda/kybern/ci.yml?branch=main&label=CI&logo=github" alt="Status CI"></a>
  <a href="https://github.com/Tresnanda/kybern/releases/latest"><img src="https://img.shields.io/github/v/release/Tresnanda/kybern?color=7F77DD&label=release" alt="Rilis Terbaru"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/lisensi-MIT-6A62C9" alt="Lisensi MIT"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-534AB7?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011%20x64-3C3489?logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-x64%20(glibc%202.35+)-3C3489?logo=linux&logoColor=white" alt="Linux">
  <img src="https://img.shields.io/badge/Mobile-Android%20%7C%20iOS-1D9E75?logo=expo&logoColor=white" alt="Mobile">
</p>

<p align="center">
  <a href="#instalasi-cepat">Instalasi Cepat</a> •
  <a href="#agent-yang-didukung">Agent yang Didukung</a> •
  <a href="#fitur">Fitur</a> •
  <a href="#command-line">Command Line</a> •
  <a href="#pengembangan">Pengembangan</a> •
  <a href="GUIDE.md">Panduan</a>
</p>

---

### Kenapa Kybern?

- ⚡ **Eksekusi Paralel & Worktree Terpisah:** Jalankan beberapa coding agent sekaligus di codebase yang sama tanpa takut konflik merge atau working copy berantakan. Tiap thread bisa punya git worktree sendiri.
- 🔌 **Driver Protokol Native:** Kybern ngobrol langsung lewat protokol asli tiap agent (JSON-RPC, stdio, atau app-server), bukan mengandalkan scraping layar terminal yang gampang rusak.
- 🛡️ **Local-First & Secret Tetap Aman:** Transkrip, log, dan checkpoint tetap ada di mesinmu. API key dan secret yang diminta saat agent bekerja langsung masuk ke file `.env` yang sudah di-gitignore.
- 📱 **Bisa Jalan di Server & HP:** Jalankan daemon di server remote lewat SSH atau Tailscale, lalu pantau turn, persetujuan (approval), dan diff dari aplikasi pendamping iOS/Android.

---

## Agent yang Didukung

Kybern terhubung langsung ke berbagai harness agent populer secara native. Kamu cukup punya minimal satu agent yang sudah terpasang dan login di mesinmu. Sisanya, Kybern yang mendeteksi dan menghubungkannya otomatis:

| Harness | Lapisan Integrasi | Delegasi & Lead | Launch Mode Full Access |
|---|---|:---:|---|
| **Claude Code** | Protokol CLI native | Didukung | `--permission-mode bypassPermissions --allow-dangerously-skip-permissions` |
| **OpenAI Codex** | Protokol App-Server | Didukung | Kebijakan approval `never`, sandbox `danger-full-access` |
| **OpenCode** | Server API (v1.10+ / v2.2+) | Didukung | Aturan `*: allow` |
| **Cursor** | SDK Lokal Resmi | Didukung | Sandbox & review otomatis dimatikan |
| **Pi / Oh My Pi** | Sesi RPC / stdio | Didukung | Approval `yolo` |

---

## Instalasi Cepat

Unduh installer dan paket rilis langsung dari [GitHub Releases](https://github.com/Tresnanda/kybern/releases/latest).

| Platform | Arsitektur yang Didukung | Cara yang Direkomendasikan |
|---|---|---|
| **macOS** | Apple Silicon (`aarch64`) & Intel (`x86_64`) | `curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh \| sh` |
| **Windows** | Windows 10 (1809+) & Windows 11 (x64) | [Unduh Setup `.exe`](https://github.com/Tresnanda/kybern/releases/latest) |
| **Linux** | Ubuntu, Debian, Fedora, openSUSE, Arch (x64) | `curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-linux-install.sh \| sh` |
| **Remote Server** | Headless Linux & macOS (via SSH / Tailscale) | `curl -LsSf https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh \| sh -s -- --service` |
| **Aplikasi Mobile** | Android & iOS | [Unduh Preview APK](https://github.com/Tresnanda/kybern/releases/download/android-build-9/kybern-0.1.2-android-build-9.apk) |

---

### Detail per Platform

#### macOS

Mendukung Apple Silicon (`aarch64`) dan Intel (`x86_64`).

```sh
curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh
```

Bisa juga unduh manual `kybern-gpuix_<version>_aarch64.app.tar.gz` atau `_x86_64.app.tar.gz` dari [halaman rilis terbaru](https://github.com/Tresnanda/kybern/releases/latest).

> [!NOTE]
> **Catatan Gatekeeper di macOS (pertama kali buka):**
> Kalau diunduh lewat browser, Gatekeeper akan memunculkan pesan *"Apple could not verify Kybern is free of malware"*.
>
> 1. Klik **Done** pada dialog tersebut (jangan pilih Move to Trash).
> 2. Buka **System Settings → Privacy & Security**, scroll ke bagian **Security**, lalu klik **Open Anyway** di samping Kybern:
>    <br><br>
>    <img src="assets/readme/gatekeeper-open-anyway.png" alt="Open Anyway di Privacy & Security" width="600">
> 3. Konfirmasi dengan **Open Anyway** memakai Touch ID atau kata sandi kamu:
>    <br><br>
>    <img src="assets/readme/gatekeeper-confirm.png" alt="Konfirmasi membuka Kybern" width="440">
>
> *(Kalau pakai script instalasi curl di atas, langkah ini otomatis dilewati).*

---

#### Windows

Mendukung Windows 10 (versi 1809 ke atas) dan Windows 11, x64.

1. Unduh `kybern-gpuix_<version>_x64-setup.exe` dari [Releases](https://github.com/Tresnanda/kybern/releases/latest).
2. Jalankan installer-nya. Kybern terpasang khusus untuk akun penggunamu, jadi tidak perlu hak administrator.
3. Kalau Microsoft Defender SmartScreen menampilkan peringatan, klik **More info → Run anyway**.

---

#### Linux

Untuk distro x86_64 dengan glibc 2.35 atau lebih baru (Ubuntu 22.04+, Debian 12+, Fedora 36+, openSUSE Leap 16 / Tumbleweed, Arch Linux):

```sh
curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-linux-install.sh | sh
```

- Installer akan mengenali package manager-mu lalu memasang `.deb` (lewat `apt`) atau `.rpm` (lewat `dnf` atau `zypper`), dan memakai AppImage kalau keduanya tidak cocok.
- Mau langsung pakai AppImage? Tambahkan `sh -s -- --appimage`.
- Mau uninstall? Tambahkan `sh -s -- --uninstall` (data kamu di `~/.kybern` tetap aman).

---

#### Aplikasi Pendamping Mobile (Android & iOS)

Tetap bisa memantau pekerjaan agent walau sedang jauh dari meja kerja. Aplikasi pendamping ini bisa menampilkan percakapan secara streaming, meminta persetujuan, melihat file dan diff, serta mengelola tugas project.

- **Android:** Unduh APK preview dari [rilis GitHub](https://github.com/Tresnanda/kybern/releases/download/android-build-9/kybern-0.1.2-android-build-9.apk).
- **iOS:** Tersedia lewat development build (lihat [Panduan Mobile Companion](apps/mobile/README.md)).
- **Pairing:** Di aplikasi desktop, klik **Pair a device** lalu scan kode QR dengan HP-mu. Kalau HP tidak satu jaringan dengan komputer, aktifkan **Reachable over Tailscale**.

---

#### Headless Server / Remote Agent

Jalankan daemon di server khusus atau VPS, lalu kendalikan dari aplikasi desktop atau HP:

- **Lewat Aplikasi Desktop:** Pilih **Switch environment → Add environment → Over SSH** dan isi `user@host`. Kybern akan memasang daemon dan membuat tunnel SSH sendiri.
- **Setup Server Manual:** Pasang daemon dan CLI sebagai systemd user service yang terus berjalan:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh | sh -s -- --service
```

---

## Fitur

- **Multi-Agent Threads:** Buka beberapa sesi agent berdampingan. Tiap thread punya agent, model, dan tingkat izinnya sendiri. Kamu juga bisa pindah ke harness atau akun lain kapan saja tanpa kehilangan percakapan.
- **Riwayat Turn yang Detail:** Setiap turn dirangkum rapi (contoh: *"Worked for 3m"*) lengkap dengan perintah terminal, edit file, dan git diff. Perubahan file bisa dibatalkan, atau percakapan bisa diputar balik (*rewind*) ke checkpoint sebelumnya.
- **Delegasi Otomatis & Coordinator:** Cukup bilang *"minta Codex yang mengerjakan ini, lalu Claude yang me-review"*. Agent pembantu akan muncul sebagai sub-thread yang terhubung. Project juga bisa punya **Coordinator**, yaitu lead thread jangka panjang yang menyusun tugas dan meninjau hasilnya.
- **Approval Interaktif & Secret Terlindungi:** Permintaan izin, pertanyaan, dan permintaan API key muncul sebagai kartu interaktif di desktop maupun HP. Secret langsung ditulis ke file `.env` yang di-gitignore dan tidak pernah masuk ke chat.
- **Workspace Terpadu:** Terminal, file explorer, code editor, review pull request, catatan, dan tugas semuanya ada di samping percakapanmu.
- **Preview Langsung di Aplikasi:** Agent bisa menampilkan halaman web interaktif atau preview dev server langsung di dalam thread, tanpa bentrok port.
- **Lanjutkan Sesi Native:** Lanjutkan percakapan yang dulu dimulai dari CLI asli agent (Claude Code, Codex, OpenCode, Cursor, Pi) lengkap dengan riwayat pesan dan tool yang pernah dijalankan.

*Mau tahu alur kerja lanjutan, izin, dan pengaturan lainnya? Baca [Panduan Kybern (GUIDE.md)](GUIDE.md).*

---

## Command Line

Kybern punya CLI (`kybern`) yang terhubung ke daemon yang sama dengan aplikasi desktop:

```sh
# Lihat harness agent yang terpasang dan sudah login
kybern providers

# Mulai tugas baru di project saat ini
kybern new -p . "jelaskan isi repo ini dalam tiga baris"

# Lihat thread aktif dan pantau live events
kybern threads
kybern watch

# Kirim pesan ke thread yang sedang aktif
kybern send <thread-id> "terapkan feedback tadi lalu jalankan test"

# Lanjutkan sesi tersimpan dari Claude Code atau Codex
kybern sessions --provider claude-code
kybern resume --provider claude-code <native-session-id>
```

Aktifkan integrasi PATH otomatis di **Settings → About → Terminal command → Install**.

---

## Pembaruan

Kybern mengecek pembaruan otomatis saat dibuka dan setiap beberapa jam sekali (atau manual lewat **Settings → About**). Begitu ada pembaruan, kartu notifikasi akan muncul. Tinggal klik **Update and restart** untuk menerapkannya.

Untuk distro Linux yang memakai `.deb` atau `.rpm`, Kybern akan menampilkan perintah `apt` atau `dnf` yang perlu kamu jalankan. Percakapan yang sedang berjalan tetap tersimpan dan bisa dilanjutkan di pesan berikutnya.

*(Catatan: Aplikasi desktop lama berbasis Tauri sudah dipensiunkan setelah versi 0.18.0. Kybern GPUIX memakai data yang sama di `~/.kybern`, jadi project dan riwayat percakapanmu tetap terbawa).*

---

## Pengembangan

Build daemon Rust, CLI, dan aplikasi desktop GPUIX langsung dari source:

```sh
# Build daemon Rust dan CLI
cargo build -p kybern

# Jalankan daemon lokal untuk percobaan
./target/debug/kybernd --data-dir /tmp/kyb --port 4199

# Build dan jalankan aplikasi desktop Kybern GPUIX
cd apps/gpuix
pnpm install --frozen-lockfile
native/update.sh                      # build patched GPUIX addon
KYBERN_DATA_DIR=/tmp/kyb pnpm dev
```

Detail soal pengujian dan cara berkontribusi ada di [CONTRIBUTING.md](CONTRIBUTING.md) dan [RELEASING.md](RELEASING.md).

---

## Arsitektur & Privasi

Kybern dibuat dengan prinsip **local-first**:
- **Tanpa Cloud Relay:** Semua lalu lintas data tetap ada di mesin dan jaringan privatmu. Aplikasi terhubung langsung ke daemon lokal, atau ke mesin-mesinmu yang lain lewat Tailscale (atau relay peer milikmu sendiri), tanpa server cloud pihak ketiga di tengahnya.
- **Privasi Data:** Transkrip, git checkpoint, dan konfigurasimu tetap tersimpan di mesinmu, di folder `~/.kybern`. Tidak ada pelacakan, telemetri, ataupun analitik pihak ketiga.
- **Keamanan Secret:** API key yang diminta lewat `kybern_request_secret` ditulis langsung ke file `.env` project yang di-gitignore, tanpa pernah lewat konteks chat.

---

## Ucapan Terima Kasih

Kybern terinspirasi dari karya komunitas agentic coding, terutama [T3 Code](https://github.com/pingdotgg/t3code) dan [Synara](https://github.com/Emanuele-web04/synara).

---

## Lisensi

Dirilis dengan [Lisensi MIT](LICENSE).

<p align="center">
  <a href="https://star-history.com/#Tresnanda/kybern&Date">
    <img src="https://api.star-history.com/svg?repos=Tresnanda/kybern&type=Date" alt="Grafik Star History" width="600">
  </a>
</p>
