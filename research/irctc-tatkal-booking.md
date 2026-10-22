# Research: How IRCTC Tatkal booking works

Researched 2026-10-22. Case study, `case-studies` track.

**Method caveat.** Page fetches were blocked from the research container (DNS failures), so facts
below come from search-result summaries of the linked pages. Before the next review, open each
link and re-check wording and dates. Flags mark where sources disagree.

## Public rules (as of October 2026)

- Tatkal opens one day before the journey (excluding the journey date): AC classes at 10:00, non-AC
  at 11:00. Staggered timings since 15 June 2015 to reduce server load.
  https://www.businesstoday.in/story/railway-tatkal-ticket-booking-timings-changed-from-today/1/220563.html
  IRCTC denied rumours of new timings in April 2025:
  https://www.businesstoday.in/india/story/new-tatkal-ticket-rules-from-april-15-heres-what-irctc-has-to-say-471774-2025-04-11
- Ministry circular, 10 June 2025: from 1 July 2025 only Aadhaar-authenticated users can book
  Tatkal online; from 15 July 2025 an Aadhaar OTP too, also at counters and for agents. Agents are
  barred for the first 30 minutes (10:00–10:30 AC, 11:00–11:30 non-AC).
  https://www.newsonair.gov.in/railways-announces-new-rules-for-tatkal-tickets-aadhaar-based-otp-authentication-must-from-july-1
  FLAG: rollout was phased. Online Tatkal OTP live on 322 trains by 11 Dec 2025.
  https://morungexpress.com/aadhaar-otp-verification-now-in-322-trains-for-online-tatkal-booking-3-crore-fake-user-ids-busted
- From 1 Oct 2025, only Aadhaar-authenticated users can book online in the first 15 minutes of
  general (ARP) opening day booking.
  https://www.newsonair.gov.in/railways-to-allow-general-ticket-booking-online-only-for-aadhaar-verified-users-during-first-15-minutes-from-next-month
- Max 4 passengers per Tatkal PNR (Lok Sabha answer; Business Today Apr 2025 above).
- Tatkal quota set per train by zonal railways from past use. 2015 Lok Sabha caps: 2AC 10 berths
  per coach, 3AC 16, chair car 16, Sleeper up to 30%. FLAG: verify the PDF.
  https://eparlib.nic.in/bitstream/123456789/658143/1/12864.pdf
- Advance reservation period cut from 120 to 60 days from 1 Nov 2024.
  https://www.newsonair.gov.in/railways-reduces-time-limit-for-advance-ticket-booking-from-120-to-60-days
- First chart prepared about 8 hours before departure (CC 10/2025, 2 Jul 2025).
  https://www.newsonair.gov.in/railway-board-to-prepare-reservation-charts-8-hours-prior-to-train-departure
- Waitlist cap: 25% of capacity decided Apr 2025, implemented 16 Jun 2025, raised to 60% (AC) and
  30% (non-AC) around 29 Jun 2025. Officials: 20–25% of waitlisted tickets usually confirm.
  https://www.theweek.in/wire-updates/national/2025/06/29/del48-rail-enhances-waiting-list.html
- Fully waitlisted e-tickets are cancelled automatically after charting and refunded minus
  clerkage. https://eparlib.nic.in/bitstream/123456789/951605/1/AU1903.pdf
- Premium Tatkal (2014): part of the quota sold at a dynamic fare. FLAG: 50% vs 30% share unclear.
  https://www.business-standard.com/article/pti-stories/tatkal-booking-linked-to-dynamic-pricing-system-fares-to-go-up-114100200620_1.html

## Scale

- IRCTC's page: 30,155 tickets in one minute on 12 Mar 2025 at 10:01 (older version: 28,434 on
  12 Nov 2022). https://irctc.com/internet-ticketing.html
- IANS, 3 Jun 2026: peak 37,410 per minute on 16 Aug 2025; average 14.53 lakh tickets a day in
  FY 2025-26. https://ianslive.in/irctc-delivers-58-crore-meals-a-year-handles-18-lakh-daily-tickets--20260603170101
- Record day: 20,06,353 bookings on 7 Sep 2026; 08:00–08:15 is the busiest slot of general booking.
  https://www.businesstoday.in/india/story/how-irctc-pulled-a-record-2-million-train-ticket-booking-on-a-single-day-554997-2026-09-11
- About 89% of reserved tickets booked online (Rajya Sabha, Jul 2025; ~49% in 2013-14).
  https://www.theweek.in/wire-updates/national/2025/07/25/del90-rsq-rail-online-ticket.html
  https://newsonair.gov.in/railways-minister-ashwini-vaishnaw-says-89-of-reserved-tickets-are-now-booked-online/
- NGeT (2014, CRIS): 2,000 → 7,200 tickets/min, 40,000 → 1.2 lakh concurrent users; 2015 raised to
  15,000/min. https://www.newslaundry.com/2016/01/20/from-29-tickets-booked-in-a-day-to-13-lakh-tickets-a-day-irctc-has-come-a-long-way
- Old load data: Tatkal-hour hits over 20 lakh vs normal 6–7 lakh (2012 era).
  https://www.medianama.com/2012/07/223-irctc-takes-several-steps-to-improve-tatkal-ticket-bookings/
- Next-gen PRS targets over 1.5 lakh bookings/min. Phased migration from Aug 2026.
  https://www.tribuneindia.com/news/india/just-like-airlines-now-you-can-choose-your-seat-when-travelling-by-train
  https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/aug/doc202686945401.pdf
- Capacity claims conflict (25,000 vs 30,000 vs 32,000 per minute). Present as a range.

## Bots

- Ministry, 4 Jun 2025: AI-based system deactivated ~2.5 crore suspicious IDs; anti-bot with "a
  leading CDN provider"; bots up to 50% of login attempts in the first 5 minutes of Tatkal.
  https://ianslive.in/indian-railways-ai-system-cracks-down-on-25-crore-suspicious-user-ids--20250604161204
- Dec 2025: 3.02 crore IDs deactivated since Jan 2025; confirmed Tatkal availability time up ~65%
  on OTP trains (government claim).
  https://www.newsonair.gov.in/government-deactivates-over-3-crore-suspicious-railway-user-ids/
- RPF busts of illegal software (ANMS, Red Mirchi, MAC, Jaguar) that bypassed CAPTCHA and bank OTP,
  Feb 2020. https://www.onmanorama.com/news/india/2020/02/18/indian-railways-tatkal-ticket-illegal-software.html
- Vendor is not named officially. Do not name one.

## Outages (no public root causes)

- 26 Dec 2024, ~1.5 h, "maintenance".
  https://business-standard.com/india-news/irctc-website-down-here-s-how-you-can-book-or-cancel-your-train-tickets-124122600390_1.html
- 31 Dec 2024, around 10 AM during Tatkal, third outage that month.
  https://www.businesstoday.in/amp/india/story/irctc-website-down-site-and-app-experience-major-outage-ahead-of-new-year-third-in-a-month-459099-2024-12-31

## Payments

- RBI circular on turnaround time for failed transactions, 20 Sep 2019, effective 15 Oct 2019:
  auto-reversal deadlines (T+1 to T+5 by channel) and ₹100/day compensation after them.
  https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11693
  FLAG: person-to-person UPI is T+1; merchant cases T+5. Phrase generally.
- IRCTC starts automatic refunds for debited-but-not-booked transactions; banks take a few working
  days. https://www.etvbharat.com/en/!bharat/passengers-to-get-money-back-in-one-hour-as-irctc-refunds-get-faster-enn24031402147
- UPI ~51% of IRCTC bookings in Q1 FY27.
  https://newskarnataka.com/india/irctc-faces-profit-pressure-as-upi-bookings-cross-51/16082026/

## Inside the system

- Reservation core is CRIS's PRS ("CONCERT", OpenVMS, RTR middleware), counters and web share it.
  https://www.voicendata.com/transformational-it-projects-from-yore-indian-railways-passenger-reservation-system
- No official talk or paper on seat locking or a virtual queue. Everything on our page beyond the
  sourced facts is a design for a system like it.

## Generic flash-sale engineering

- Cloudflare Waiting Room (Jun 2021): signed cookie, Durable Objects.
  https://blog.cloudflare.com/building-waiting-room-on-workers-and-durable-objects
- Queue-it: queue IDs, users per minute; randomising the pre-queue to blunt bots.
  https://queue-it.com/developers/how-queue-it-works
  https://www.queue-it.com/blog/first-in-first-out-randomization
- AWS Virtual Waiting Room solution. https://docs.aws.amazon.com/solutions/latest/virtual-waiting-room-on-aws/architecture-overview.html
- Ticketmaster Eras Tour presale, Nov 2022: 3.5 billion system requests, 4× previous peak.
  https://www.cbsnews.com/amp/pittsburgh/news/ticketmaster-cancels-taylor-swift-eras-tour-ticket-sales
- Stripe idempotency keys. https://stripe.com/blog/idempotency

## Misconceptions

- "The site crashes because the servers are weak." Demand at 10:00:00 is hundreds of times the
  daily average, synchronised to the second; retries multiply it.
- "Add a lock on the seat table." A single lock row per train-class is the hot spot; the design
  must keep the critical section tiny.
- "Money deducted means the railway kept my money." Usually the payment and booking are two
  systems with no shared transaction; reconciliation refunds it.

## How explainers structure it, and what they leave out

- Generic "IRCTC system design" posts draw microservices + Redis + Kafka, presented as if real.
- They miss: counters and web share one quota; the controls IRCTC actually uses (staggered times,
  agent embargo, 4-passenger cap, Aadhaar OTP); the payment reconciliation and RBI refund rules.
- Our angle: separate sourced facts from our design, show the spike and retry storm in a sim,
  and spend real time on the payment gap.
