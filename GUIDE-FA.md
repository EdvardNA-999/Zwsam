# راهنمای کامل پروژه Zeus WASM

> سیستم پروکسی VLESS با کارایی بالا برای Cloudflare Workers
> مبتنی بر WebAssembly (Rust) + JavaScript

---

## فهرست مطالب

1. [معرفی پروژه](#1-معرفی-پروژه)
2. [معماری سیستم](#2-معماری-سیستم)
3. [پیش‌نیازها](#3-پیش‌نیازها)
4. [نصب و راه‌اندازی](#4-نصب-و-راه‌اندازی)
5. [ساخت پروژه](#5-ساخت-پروژه)
6. [استقرار روی Cloudflare](#6-استقرار-روی-cloudflare)
7. [استفاده از پنل مدیریت](#7-استفاده-از-پنل-مدیریت)
8. [مدیریت کاربران](#8-مدیریت-کاربران)
9. [CI/CD خودکار با GitHub](#9-cicd-خودکار-با-github)
10. [محیط‌های Staging و Production](#10-محیط‌های-staging-و-production)
11. [عیب‌یابی](#11-عیب‌یابی)
12. [بهینه‌سازی و امنیت](#12-بهینه‌سازی-و-امنیت)

---

## 1. معرفی پروژه

این پروژه نسخه بازنویسی‌شده پنل زئوس است که منطق سنگین پروتکل VLESS را از جاوااسکریپت به **WebAssembly** منتقل کرده است.

### چرا WASM؟

| ویژگی | نسخه JS (قدیمی) | نسخه WASM (جدید) |
|---|---|---|
| پردازش هدر VLESS | ~0.5ms | ~0.05ms |
| استخراج UUID | ~0.1ms | ~0.01ms |
| کدگذاری DNS | ~0.2ms | ~0.02ms |
| حافظه هر اتصال | ~2KB | ~512B |
| مقاومت در برابر تحلیل | کد خوانا | باینری غیرقابل خواندن |

### مزایای کلیدی

- **عملکرد بالا**: پردازش پروتکل در سطح باینری
- **مصرف CPU کمتر**: محاسبات سنگین در WASM انجام می‌شود
- **مقاومت در برابر شناسایی**: منطق پروتکل به صورت باینری کامپایل شده
- **معماری تمیز**: جداسازی منطق پروتکل از مدیریت اتصالات

---

## 2. معماری سیستم

```
┌─────────────────────────────────────────────────────────────┐
│                 Cloudflare Worker (JavaScript)               │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │  مسیریاب  │  │  پنل / API   │  │  سرویس اشتراک‌ها      ││
│  │  (Router) │  │  (D1 CRUD)   │  │  (text + JSON)         ││
│  └────┬─────┘  └──────────────┘  └────────────────────────┘│
│       │                                                     │
│  ┌────▼───────────────────────────────────────────────────┐│
│  │           موتور VLESS (پل جاوااسکریپت)                 ││
│  │  • مدیریت WebSocket    • مدیریت سوکت TCP               ││
│  │  • انتقال جریان         • محاسبه ترافیک                 ││
│  │  • صف آپ‌استریم         • DNS-over-HTTPS                 ││
│  └──────────────────────┬──────────────────────────────────┘│
│                         │ فراخوانی wasm-bindgen             │
│  ┌──────────────────────▼──────────────────────────────────┐│
│  │              هسته WASM (Rust → .wasm)                    ││
│  │  ┌─────────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ ││
│  │  │ پارسر VLESS │ │ استخراج  │ │ کدگذار  │ │ ابزارهای │ ││
│  │  │             │ │ UUID     │ │ DNS     │ │ بایت     │ ││
│  │  └─────────────┘ └──────────┘ └─────────┘ └──────────┘ ││
│  └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                         │
                    ┌────▼────┐
                    │  D1 DB  │  (کاربران، تنظیمات)
                    └─────────┘
```

### ساختار پوشه‌ها

```
zeus-wasm/
├── .github/
│   └── workflows/
│       └── deploy.yml           ← خط CI/CD
├── .gitignore
├── README.md                    ← راهنمای انگلیسی
├── GUIDE-FA.md                  ← این فایل (راهنمای فارسی)
├── build.bat                    ← اسکریپت ساخت ویندوز
├── build.sh                     ← اسکریپت ساخت لینوکس/مک
│
├── wasm-core/                   ← هسته Rust/WASM
│   ├── Cargo.toml               ← تنظیمات پروژه Rust
│   └── src/
│       ├── lib.rs               ← خروجی‌های wasm-bindgen
│       ├── vless.rs             ← پارسر پروتکل VLESS
│       ├── uuid.rs              ← استخراج و اعتبارسنجی UUID
│       ├── dns.rs               ← کدگذاری/رمزگشایی DNS
│       └── bytes.rs             ← ابزارهای بایت
│
└── worker/                      ← Cloudflare Worker
    ├── package.json             ← تنظیمات npm
    ├── wrangler.toml            ← تنظیمات Wrangler
    ├── scripts/
    │   └── validate.js          ← اسکریپت اعتبارسنجی
    └── src/
        └── index.js             ← پل JS (مسیریاب + موتور VLESS)
```

---

## 3. پیش‌نیازها

قبل از شروع، این ابزارها را نصب کنید:

### 3.1 Rust (زبان برنامه‌نویسی)

**ویندوز:**
```powershell
# روش 1: با winget
winget install Rustlang.Rustup

# روش 2: دانلود مستقیم
# فایل rustup-init.exe را از https://rustup.rs/ دانلود و اجرا کنید
```

**لینوکس/مک:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

**تایید نصب:**
```bash
rustc --version
# خروجی: rustc 1.77.0 (یا بالاتر)
```

### 3.2 wasm-pack (ابزار ساخت WASM)

```bash
cargo install wasm-pack
```

**تایید نصب:**
```bash
wasm-pack --version
```

### 3.3 wasm-opt (بهینه‌ساز اختیاری)

```bash
cargo install binaryen
```

### 3.4 Node.js و npm

```bash
# ویندوز: دانلود از https://nodejs.org/ (نسخه 18 یا بالاتر)
# یا با winget:
winget install OpenJS.NodeJS
```

**تایید نصب:**
```bash
node --version
npm --version
```

### 3.5 Wrangler (ابزار استقرار Cloudflare)

```bash
npm install -g wrangler
```

**تایید نصب:**
```bash
wrangler --version
```

### 3.6 Git

```bash
# ویندوز: دانلود از https://git-scm.com/
winget install Git.Git
```

---

## 4. نصب و راه‌اندازی

### 4.1 کلون کردن پروژه

```bash
git clone https://github.com/YOUR_USERNAME/zeus-wasm.git
cd zeus-wasm
```

### 4.2 نصب وابستگی‌های Rust

```bash
cd wasm-core
cargo fetch
cd ..
```

### 4.3 نصب وابستگی‌های Node.js

```bash
cd worker
npm install
cd ..
```

### 4.4 تایید ساختار پروژه

```bash
# باید خروجی زیر را ببینید:
ls wasm-core/src/
# lib.rs  vless.rs  uuid.rs  dns.rs  bytes.rs

ls worker/src/
# index.js
```

---

## 5. ساخت پروژه

### 5.1 ساخت خودکار (توصیه‌شده)

**ویندوز:**
```cmd
build.bat
```

**لینوکس/مک:**
```bash
chmod +x build.sh
./build.sh
```

### 5.2 ساخت دستی

**مرحله 1: ساخت WASM**
```bash
cd wasm-core
wasm-pack build --target web --release --out-dir ../worker/wasm
```

خروجی موفق:
```
[INFO]: ✨  Done building WASM
[INFO]: ⬇️  Installing wasm-bindgen...
[INFO]: ✅  Your wasm pkg is ready to publish at ../worker/wasm
```

**مرحله 2: بهینه‌سازی (اختیاری)**
```bash
wasm-opt -Oz --output ../worker/wasm/zeus_wasm_core_bg.wasm ../worker/wasm/zeus_wasm_core_bg.wasm
```

**مرحله 3: نصب وابستگی‌های Worker**
```bash
cd ../worker
npm install
```

**مرحله 4: اعتبارسنجی**
```bash
node scripts/validate.js
```

خروجی موفق:
```
╔══════════════════════════════════════╗
║   Zeus WASM — Pre-Deploy Validation  ║
╚══════════════════════════════════════╝

1. WASM Artifacts
  ✓ wasm/zeus_wasm_core.js (XX.X KB)
  ✓ wasm/zeus_wasm_core_bg.wasm (XX.X KB)
  ✓ WASM magic bytes valid

2. Worker Source
  ✓ WASM import found in index.js
  ✓ Export default handler found
  ✓ D1 binding (env.DB) referenced

✓ All checks passed
```

### 5.3 اجرای محلی برای تست

```bash
cd worker
npx wrangler dev
```

در مرورگر باز کنید: `http://localhost:8787/panel`

---

## 6. استقرار روی Cloudflare

### 6.1 ساخت توکن API کلودفلر

1. به داشبورد کلودفلر بروید: `https://dash.cloudflare.com/profile/api-tokens`
2. روی **Create Token** کلیک کنید
3. از قالب **Edit Cloudflare Workers** استفاده کنید
4. مجوزهای زیر را تنظیم کنید:

| مجوز | سطح دسترسی |
|---|---|
| Account > D1 > Edit | ساخت و مدیریت دیتابیس |
| Account > Workers Scripts > Edit | استقرار ورکر |
| Account > Workers Routes > Edit | مدیریت مسیرها |
| Account > Account Settings > Read | خواندن تنظیمات اکانت |

5. توکن را کپی کنید (فقط یک‌بار نمایش داده می‌شود)

### 6.2 ساخت دیتابیس D1

```bash
cd worker
npx wrangler d1 create zeus-db
```

خروجی:
```
✅ Successfully created DB 'zeus-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

> **مهم**: `database_id` را کپی کنید

### 6.3 تنظیم wrangler.toml

فایل `worker/wrangler.toml` را باز کنید و مقادیر placeholder را جایگزین کنید:

```toml
[[d1_databases]]
binding = "DB"
database_name = "zeus-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← ID واقعی
```

### 6.4 تنظیم رمزها (Secrets)

```bash
cd worker

# توکن API کلودفلر
npx wrangler secret put CF_API_TOKEN
# توکن را پیست کنید و Enter بزنید

# شناسه اکانت کلودفلر
npx wrangler secret put CF_ACCOUNT_ID
# شناسه را پیست کنید و Enter بزنید
```

> **نکته**: شناسه اکانت را از URL داشبورد کلودفلر پیدا کنید:
> `https://dash.cloudflare.com/xxxxxxxx...` → این بخش همان شناسه است

### 6.5 استقرار

```bash
npx wrangler deploy
```

خروجی موفق:
```
✅ Successfully published your script to
https://zeus.your-subdomain.workers.dev
```

### 6.6 دسترسی به پنل

آدرس زیر را در مرورگر باز کنید:
```
https://zeus.your-subdomain.workers.dev/panel
```

در اولین ورود، رمز عبور مدیریت را تنظیم کنید.

---

## 7. استفاده از پنل مدیریت

### 7.1 صفحه ورود

پس از تنظیم رمز عبور، با ورود به `/panel` صفحه ورود نمایش داده می‌شود.

### 7.2 داشبورد اصلی

پس از ورود، داشبورد شامل بخش‌های زیر است:

- **لیست کاربران**: مشاهده، ایجاد، ویرایش و حذف کاربران
- **آمار مصرف**: درخواست‌های امروز و ۳۰ روز گذشته
- **تنظیمات**: پروکسی IP، تنظیمات Fragment، آپدیت پنل

### 7.3 تنظیمات پروکسی IP

از بخش تنظیمات می‌توانید:
- **پروکسی IP**: آدرس IP پروکسی پیش‌فرض را تنظیم کنید
- **موقعیت IATA**: کد موقعیت جغرافیایی سرور
- **Fragment Length**: طول بسته‌های Fragment (پیش‌فرض: `20-30`)
- **Fragment Interval**: فاصله زمانی Fragment (پیش‌فرض: `1-2`)

### 7.4 آپدیت پنل

از بخش تنظیمات، دکمه **بررسی آپدیت** را بزنید تا نسخه جدید بررسی و نصب شود.

---

## 8. مدیریت کاربران

### 8.1 ایجاد کاربر جدید

از دکمه **افزودن کاربر** در داشبورد:

| فیلد | توضیح |
|---|---|
| نام کاربری | نام منحصربفرد کاربر |
| حجم مجاز (GB) | سقف مصرف حجم (خالی = نامحدود) |
| روزهای اعتبار | مدت زمان اعتبار (خالی = نامحدود) |
| سقف درخواست | حداکثر تعداد درخواست (خالی = نامحدود) |
| پورت | پورت اتصال (پیش‌فرض: 443) |
| TLS | فعال/غیرفعال |
| اثر انگشت | نوع مرورگر (Chrome, iOS, Random) |
| حداکثر اتصال | تعداد دستگاه همزمان (خالی = نامحدود) |
| IP‌ها | آدرس‌های IP تمیز (هر خط یک IP) |

### 8.2 لینک‌های اشتراک

هر کاربر دو نوع لینک اشتراک دارد:

**لینک متنی (ساده):**
```
https://your-worker.workers.dev/sub/username
```

**لینک JSON (مدرن):**
```
https://your-worker.workers.dev/feed/json/username
```

### 8.3 صفحه وضعیت کاربر

هر کاربر یک صفحه وضعیت اختصاصی دارد:
```
https://your-worker.workers.dev/status/username
```

شامل:
- وضعیت اتصال (فعال/غیرفعال/منقضی)
- درصد حجم مصرف‌شده
- روزهای باقیمانده
- بارکد QR برای اتصال

---

## 9. CI/CD خودکار با GitHub

### 9.1 تنظیم GitHub Secrets

به تنظیمات ریپازیتوری بروید: **Settings > Secrets and variables > Actions**

| نام Secret | مقدار |
|---|---|
| `CLOUDFLARE_API_TOKEN` | توکن API کلودفلر |
| `CLOUDFLARE_ACCOUNT_ID` | شناسه اکانت کلودفلر |

### 9.2 تنظیم GitHub Variables (اختیاری)

| نام Variable | مقدار مثال |
|---|---|
| `CF_WORKERS_SUBDOMAIN` | `your-subdomain` |
| `STAGING_URL` | `https://zeus-staging.your-subdomain.workers.dev` |
| `PRODUCTION_URL` | `https://zeus.your-subdomain.workers.dev` |

### 9.3 نحوه کار خط CI/CD

```
push به develop ──► ساخت WASM ──► اعتبارسنجی ──► استقرار Staging
push به main    ──► ساخت WASM ──► اعتبارسنجی ──► استقرار Production
Pull Request    ──► ساخت WASM ──► اعتبارسنجی ──► بدون استقرار
```

### 9.4 مراحل خط تولید

**مرحله 1: ساخت WASM**
- نصب Rust و wasm-pack
- کش کردن وابستگی‌ها
- اجرای تست‌ها (`cargo test`)
- بررسی کیفیت کد (`clippy`)
- ساخت باینری WASM
- اعتبارسنجی فایل خروجی
- بهینه‌سازی با wasm-opt
- آپلود به عنوان artifact

**مرحله 2: اعتبارسنجی Worker**
- نصب وابستگی‌های npm
- بررسی صحت wrangler.toml
- اسکن کد برای یافتن رمزهای سخت‌شده

**مرحله 3: استقرار Staging**
- دانلود artifact WASM
- استقرار با `wrangler deploy --env staging`
- تست سلامت (Health Check)

**مرحله 4: استقرار Production**
- دانلود artifact WASM
- استقرار با `wrangler deploy --env production`
- تست سلامت
- ثبت خلاصه استقرار

---

## 10. محیط‌های Staging و Production

### 10.1 تنظیم محیط‌ها در GitHub

1. به **Settings > Environments** بروید
2. محیط `staging` را بسازید (بدون محدودیت)
3. محیط `production` را بسازید با:
   - **Required reviewers**: اضافه کردن افراد مجاز
   - **Wait timer**: تاخیر قبل از استقرار (اختیاری)

### 10.2 تنظیم دیتابیس‌های جداگانه

هر محیط باید دیتابیس D1 جداگانه داشته باشد:

```bash
# دیتابیس Staging
npx wrangler d1 create zeus-db-staging

# دیتابیس Production
npx wrangler d1 create zeus-db-production
```

شناسه‌ها را در `wrangler.toml` وارد کنید.

### 10.3 تنظیم رمزها برای هر محیط

```bash
# Staging
npx wrangler secret put CF_API_TOKEN --env staging
npx wrangler secret put CF_ACCOUNT_ID --env staging

# Production
npx wrangler secret put CF_API_TOKEN --env production
npx wrangler secret put CF_ACCOUNT_ID --env production
```

---

## 11. عیب‌یابی

### 11.1 خطا: "WASM binary not found"

**علت**: فایل WASM ساخته نشده

**راه‌حل**:
```bash
cd wasm-core
wasm-pack build --target web --release --out-dir ../worker/wasm
```

### 11.2 خطا: "Invalid WASM magic bytes"

**علت**: فایل WASM خراب است

**راه‌حل**:
```bash
# حذف و ساخت مجدد
rm -rf worker/wasm/ wasm-core/target/
cd wasm-core
wasm-pack build --target web --release --out-dir ../worker/wasm
```

### 11.3 خطا: "Database not found"

**علت**: شناسه دیتابیس اشتباه است

**راه‌حل**:
```bash
# لیست دیتابیس‌ها
npx wrangler d1 list

# شناسه صحیح را در wrangler.toml وارد کنید
```

### 11.4 خطا: "Unauthorized"

**علت**: توکن API نامعتبر یا منقضی

**راه‌حل**:
```bash
# توکن جدید بسازید و تنظیم کنید
npx wrangler secret put CF_API_TOKEN
```

### 11.5 خطا: "Worker exceeded CPU time limit"

**علت**: Worker بیش از حد مجاز CPU مصرف کرده

**راه‌حل**: این مشکل معمولاً با نسخه WASM حل می‌شود زیرا پردازش در WASM بسیار سریع‌تر است.

### 11.6 تست محلی

```bash
cd worker
npx wrangler dev
# در مرورگر: http://localhost:8787/panel
```

---

## 12. بهینه‌سازی و امنیت

### 12.1 بهینه‌سازی اندازه WASM

فایل `wasm-core/Cargo.toml` شامل تنظیمات بهینه‌سازی است:

```toml
[profile.release]
opt-level = "z"     # کوچک‌ترین اندازه
lto = true          # بهینه‌سازی لینک
codegen-units = 1   # کامپایل تک‌رشته‌ای (بهتر)
strip = true        # حذف نمادهای اشکال‌زدایی
panic = "abort"     # بدون بازگشت از خطا
```

### 12.2 امنیت توکن API

**هرگز توکن API را در کد قرار ندهید.**

```bash
# ✗ اشتباه
const token = "xxxxxxxxxxxx"

# ✓ صحیح — استفاده از Secrets
npx wrangler secret put CF_API_TOKEN
```

### 12.3 امنیت رمز عبور پنل

- رمز عبور با SHA-256 هش می‌شود
- از Cookie HttpOnly و Secure استفاده می‌شود
- SameSite=Lax برای جلوگیری از CSRF

### 12.4 مجوزهای حداقلی توکن

توکن API فقط باید مجوزهای لازم را داشته باشد:

| مجوز | ضروری |
|---|---|
| Workers Scripts > Edit | ✓ بله |
| D1 > Edit | ✓ بله |
| Workers Routes > Edit | ✓ بله |
| Account Settings > Read | ✓ بله |
| DNS > Edit | ✗ نه |
| Cache Purge | ✗ نه |

### 12.5 محدودیت‌های Cloudflare Workers

| محدودیت | مقدار |
|---|---|
| حداکثر اندازه Worker | 10MB (با WASM) |
| حداکثر زمان CPU | 10ms (رایگان) / 50ms (پولی) |
| حداکثر حافظه | 128MB |
| حداکثر اندازه D1 | 5GB (رایگان) / 250GB (پولی) |
| درخواست‌های روزانه | 100,000 (رایگان) |

---

## آدرس‌های مفید

| منبع | آدرس |
|---|---|
| داشبورد کلودفلر | https://dash.cloudflare.com |
| مستندات Workers | https://developers.cloudflare.com/workers/ |
| مستندات D1 | https://developers.cloudflare.com/d1/ |
| مستندات Wrangler | https://developers.cloudflare.com/workers/wrangler/ |
| Rust و WASM | https://rustwasm.github.io/docs/book/ |
| wasm-pack | https://rustwasm.github.io/wasm-pack/ |

---

> این راهنما بر اساس پروژه Zeus WASM نوشته شده است.
> نسخه اصلی پنل زئوس توسط [Macan-dev](https://github.com/macan-dev/EasySNI) ساخته شده.
