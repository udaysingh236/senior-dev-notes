# Research: How Google Authenticator works (TOTP)

Slug: `case-studies/google-authenticator` · researched 2026-11-06 · from the Inbox (saved 2026-11-06).

User note to cover: how the code on the phone matches the one the server computes, and how it gives
the right number even without internet.

## Key facts

- Google released Authenticator in 2010 ([Google Security Blog, Apr 2023](https://security.googleblog.com/2023/04/google-authenticator-now-supports.html)).
- The app implements TOTP (RFC 6238, 2011) on top of HOTP (RFC 4226, 2005). Both are in force,
  cited only for what they specify.
- HOTP: `HMAC-SHA-1(K, C)`, C = 8-byte big-endian counter; dynamic truncation: offset = low 4 bits of
  last byte, 4 bytes from offset, mask top bit (avoids signed/unsigned ambiguity), mod 10^digits.
  RFC 4226 §4: secret MUST be ≥128 bits, RECOMMENDS 160. §7.3 throttling; §7.4 look-ahead resync.
- TOTP: `T = floor((now − T0) / X)`, T0 = 0, X = 30 s recommended. §5.2: RECOMMEND at most one step
  allowed for network delay; verifier MUST NOT accept the same OTP twice after success.
  §6: record detected drift in steps and validate later OTPs against the adjusted time.
- Unix time has no time zone: DST and travel do not change T.
- Key URI format `otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer` (+ algorithm, digits,
  period). Google's wiki says some implementations ignore `algorithm`; repo archived April 2021
  ([wiki](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)). An individual IETF draft
  formalises it ([draft-linuxgemini-otpauth-uri, 2023](https://datatracker.ietf.org/doc/draft-linuxgemini-otpauth-uri/)).
  Base32 is RFC 4648.
- Google support (read Nov 2026): codes work without internet or mobile service; "time correction
  setting is no longer available in version 7.0. The app now uses the time setting on your operating
  system"; export via Transfer codes → Export codes creates one or more QR codes
  ([support](https://support.google.com/accounts/answer/1066447)).
- Cloud sync to Google Account: announced 24 April 2023 (Android v6.0, iOS v4.0); optional.
  Researchers (Mysk) noted no end-to-end encryption; Google said E2EE planned
  ([TechCrunch 2023](https://techcrunch.com/2023/04/24/google-authenticator-can-now-sync-2fa-codes-to-the-cloud/),
  [The Hacker News 2023](https://thehackernews.com/2023/04/google-authenticator-app-gets-cloud.html)).
  Could not confirm E2EE shipped: flag for human check.
- Android phones set time from NITZ (telephony), NTP (network), optionally GNSS since Android 12
  ([AOSP automatic time detection](https://source.android.com/docs/automotive/time/automatic_time_detection) — automotive page).
  Offline, the real-time clock keeps counting.
- Apple Passwords app (iOS 18, 2024) generates TOTP codes, synced via iCloud Keychain
  ([Help Net Security, Oct 2024](https://www.helpnetsecurity.com/2024/10/15/how-to-create-verification-codes-in-apple-passwords-app/)).

## NIST SP 800-63B-4 (final, August 2025) — https://pages.nist.gov/800-63-4/sp800-63b.html

- §3.1.4: single-factor OTP; "OTP authentication is not phishing-resistant."
- §3.1.4.1: key ≥112 bits security strength (SP 800-131A). May export key into a sync fabric (App. B.2).
- §3.1.4.2: verifier keys "strongly protected" by access controls limited to components that need them;
  accept a given OTP only once while valid; TOTP lifetime = expected drift + network delay + entry time.
- §3.2.2: ≤100 consecutive failures per authenticator, then disable; 100 chosen against 6-digit OTP odds.
- §3.2.5: manual-entry authenticators (OTP) SHALL NOT be considered phishing-resistant: impostor can relay.
- Usability §8: allow at least one minute, ideally two, between OTP changes for entry.

## Numbers

- 6 digits = 10^6 codes. Window ±1 = 3 valid codes. 1 guess 3×10^-6; 100 guesses 0.030%; 50% after
  ~231,000 guesses (computed, `examples/google-authenticator`).
- 2^31 mod 10^6 = 483,648: codes below 483648 are about 1 in 2,147 more likely. Negligible bias.
- Window ±1: a code is accepted for up to 90 s of server time (from its step's start minus 30 to plus 60).
- Quartz drift 20 ppm ≈ 1.7 s/day (arithmetic, illustrative).

## Incidents (sourced)

- Retool, 27 Aug 2023: SMS phish to fake Okta page plus deepfaked voice call; employee gave one more
  OTP; attacker added device to Okta, got Google account; Authenticator cloud sync exposed all codes;
  27 cloud customers' accounts taken over ([Retool blog, Sep 2023](https://retool.com/blog/mfa-isnt-mfa)).
- 0ktapus (Group-IB, 25 Aug 2022): fake Okta pages captured 9,931 credentials and 5,441 MFA codes,
  relayed via Telegram; 130+ organisations ([Group-IB](https://www.group-ib.com/blog/0ktapus/)).
- Microsoft, 12 Jul 2022: AiTM (Evilginx2) phishing to 10,000+ orgs, steals session cookie after MFA
  ([Microsoft Security blog](https://www.microsoft.com/en-us/security/blog/2022/07/12/from-cookie-theft-to-bec-attackers-use-aitm-phishing-sites-as-entry-point-to-further-financial-fraud/)).
- Reddit, Feb 2023: employee phished on fake intranet page capturing credentials and 2FA code
  ([Malwarebytes, Feb 2023](https://www.malwarebytes.com/blog/news/2023/02/reddit-systems-compromised-by-phish-attack.-heres-what-you-need-to-do-next)).
- CISA (Oct 2022): app-based OTP resists push bombing but is vulnerable to phishing; FIDO/WebAuthn is
  phishing-resistant ([fact sheet](https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf)).

## Misconceptions

- "The phone talks to Google / the server to get the code." It never does after enrolment.
- "The code depends on my time zone." It depends on Unix time only.
- "Codes are valid for exactly 30 s." Validity depends on the server's window: usually up to 90 s.
- "The server can hash the TOTP secret like a password." It cannot: it must run HMAC with it.
- "TOTP stops phishing." It stops password reuse/stuffing, not a real-time relay.
- "A code can be reused within its 30 s." Not on a correct verifier (RFC 6238 MUST NOT, NIST SHALL).

## How explainers structure it, and what they leave out

- DEV Community ("Understanding TOTP", n.d.), MojoAuth glossary, Oloid blog: walk HMAC → truncation →
  30 s step, sometimes mention ±1 window. They stop at the algorithm.
- Left out (our angle): what the server stores and why it cannot be hashed; replay guard as a
  conditional write; drift tracking; guessing odds vs window and rate limits; what sync/export do to
  the threat model; why TOTP is not phishing-resistant, with incidents.

## Sources for Further reading

Official: RFC 4226 (2005, in force), RFC 6238 (2011, in force), RFC 4648 (2006, in force), RFC 2104 (1997, in force),
NIST SP 800-63B-4 (2025), CISA fact sheet (2022), Google support page (read 2026), Google Security Blog (2023),
Google Key URI wiki (archived 2021), IETF otpauth draft (2023), W3C WebAuthn Level 3 (2026), AOSP time detection.
Incidents: Retool (2023), Group-IB 0ktapus (2022), Microsoft AiTM (2022), Malwarebytes Reddit (2023).
News: TechCrunch (2023), The Hacker News (2023), Help Net Security (2024).
Docs: Python `hmac.compare_digest`, Node `crypto.timingSafeEqual`.
