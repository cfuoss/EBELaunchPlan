LAUNCHPLAN HUB UPDATE - AMAZON REVIEW SENTIMENT REPORT
======================================================

This package replaces only the Amazon Review Sentiment Report. It does not
change the LaunchPlan Hub homepage, upload page, or Operations tools.

INSTALLATION - WINDOWS POWERSHELL
---------------------------------

1. Download review-sentiment-report-update.zip to your Downloads folder.

2. Open PowerShell and go to the Cloudflare project:

   cd C:\Users\cfuos\secure-cpg-demo

3. Back up the report currently deployed:

   Copy-Item .\public\amazon-review-sentiment.html .\public\amazon-review-sentiment.before-update.html -Force

4. Confirm the update package exists:

   Test-Path "$env:USERPROFILE\Downloads\review-sentiment-report-update.zip"

5. Install the updated report:

   Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\review-sentiment-report-update.zip" -DestinationPath . -Force

6. Confirm the report was replaced:

   Get-Item .\public\amazon-review-sentiment.html

7. Deploy:

   npm run deploy

8. Open the report:

   https://secure-cpg-demo.launchplan-ai.workers.dev/amazon-review-sentiment.html

ROLLBACK
--------

   Copy-Item .\public\amazon-review-sentiment.before-update.html .\public\amazon-review-sentiment.html -Force
   npm run deploy
