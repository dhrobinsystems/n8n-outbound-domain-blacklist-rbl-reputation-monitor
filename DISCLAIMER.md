# Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (n8n-outbound-domain-blacklist-rbl-reputation-monitor) are provided for educational and architectural demonstration purposes.

## Provided "as is"

This software is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, accuracy, availability, and non-infringement.

## No liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, or consequential damages, including lost revenue, lost leads, damaged sender reputation, paused or unpaused campaigns, or business interruption, resulting from the use, misuse, modification, or deployment of this software.

## Third-party services can change or fail

- DNS blacklist (RBL) responses, response codes, usage policies, access rules, and availability can change at any time without notice. This includes Spamhaus, Barracuda, SORBS, and any custom zone you configure.
- Third-party APIs, including Smartlead, Instantly, and n8n, can change endpoints, authentication, behavior, rate limits, or pricing, and can experience outages. The API calls in this repository may stop working or behave differently from what is documented here.
- DNS resolvers can time out, refuse queries, be rate limited, or return incorrect data. Although this project is designed to treat ambiguous DNS results as unknown and not as a listing, no design can guarantee that false positives or false negatives will not occur.
- Blacklist listings are not proof of a deliverability problem, and a clean result is not proof that your sending infrastructure is healthy.

## Automated pausing carries operational risk

Automatically pausing outbound campaigns can interrupt revenue-generating activity. Misconfigured domain lists, incorrect campaign mappings, wrong API keys, a misbehaving resolver, stale blacklist data, or API errors can cause campaigns to be paused that should keep running, or fail to be paused when they should. Pauses may also affect other systems, teams, or customers that rely on those campaigns.

## Your responsibilities

You, the user or operator, are solely responsible for:

- Testing in a non-production environment first, with `DRY_RUN=true` and `SANDBOX_MODE=true`, before connecting this software to live accounts.
- Verifying every configuration value, including monitored targets, zone lists, campaign mappings, and credentials, before enabling live mode.
- Securing credentials, reviewing audit output, and monitoring the workflow after deployment.
- Complying with all applicable laws, regulations, and contracts, including email and data-protection rules (such as CAN-SPAM, GDPR, CCPA, CASL, and PECR), and with the terms of service and query usage policies of every provider you connect, including DNS blacklist operators, Smartlead, Instantly, and n8n.
- Assuming all risk arising from your use or modification of this software.

If you do not agree with these terms, do not use this software.

Licensed under the MIT License. See [LICENSE](LICENSE).
