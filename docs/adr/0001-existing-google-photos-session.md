# Use the existing Google Photos session for library review

Use Google Photos Toolkit's undocumented web RPC approach through a signed-in Google Photos tab, following the integration pattern demonstrated by google-photos-deduper. The official Library API is limited to app-created content and cannot provide the required review and trash workflow over an existing library; the trade-off is requiring an open Google Photos tab and maintaining an integration that Google may change without notice. Keep the integration behind an adapter, validate behavior against a live account, and pause when results or account identity are uncertain.

References: [reference extension](https://github.com/mtalcott/google-photos-deduper), [official API changes](https://developers.google.com/photos/support/updates), [GPTK RPC client](https://github.com/xob0t/Google-Photos-Toolkit/blob/cd1db961c6eacc5a3bc20304b559770ea152d930/src/api/api.ts).
