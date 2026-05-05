"""Email templates — HTML + plain-text pairs.

Three transactional templates:
  - confirm — "Подтвердите email"  (sent after register / email change)
  - reset   — "Сброс пароля"        (sent on password-reset/request)
  - welcome — "Добро пожаловать"    (sent after email is verified)

Each public function returns a dict { subject, html, text } that the
calling endpoint passes straight to send_email().

Design constraints baked in:
  - Inline CSS only — email clients (Outlook, Yandex, Mail.ru) strip
    <style> tags or apply them inconsistently
  - Table-based layout — same compatibility reason
  - Single column, 600px max — mobile-first; desktop just centres it
  - Warm-dark palette matching the app (#1A1714 bg, #F1E9D2 text,
    #C9943A ochre accent)
  - One button per email — focused CTA, no decision fatigue
  - Plain-text alternative for every HTML — required for inbox
    deliverability (anti-spam scoring penalises HTML-only)
  - No tracking pixels, no remote images — nothing that could leak
    user info or get the email flagged
  - Russian copy throughout, soft warm tone, ты not вы
"""

from server.config import OPERATOR_NAME, OPERATOR_CITY


# Telegram support — kept as a constant so a future channel rename
# is one edit. Inline rather than a config var because it's a brand
# fact, not an env-tunable.
_TELEGRAM_SUPPORT_URL    = "https://t.me/ForkWorkBro"
_TELEGRAM_SUPPORT_HANDLE = "@ForkWorkBro"


# ── HTML wrapper ──────────────────────────────────────────────────────────
# Bracketed by a centred 600px table so Outlook on Windows renders the
# layout correctly (Outlook ignores max-width on divs). The body's
# bgcolor attribute paints the warm-dark fill on the full email canvas
# even in clients that strip CSS.

def _render_html(
    *,
    preheader:    str,
    title:        str,
    intro_html:   str,
    button_text:  str | None = None,
    button_url:   str | None = None,
    after_button_html: str = "",
    footer_note_html:  str = "",
) -> str:
    """Compose the final HTML for an email. Every parameter except
    `preheader` and `title` is optional — welcome emails skip the
    button; reset emails skip the after-button copy. Caller's
    responsibility to keep the markup short enough to fit comfortably
    in a phone inbox preview."""
    button_html = ""
    if button_text and button_url:
        # Outlook-friendly button: padded <a> styled to look like a
        # button, sitting inside its own table cell so background colour
        # paints reliably in older Outlook engines. Bulletproof button
        # patterns (e.g. VML conditional comments) are overkill for the
        # warm-dark transactional aesthetic — a plain styled link button
        # renders correctly in 95%+ of modern clients.
        button_html = f"""
              <tr>
                <td align="center" style="padding: 20px 0 4px;">
                  <a href="{button_url}"
                     style="display: inline-block;
                            background: #C9943A;
                            color: #1A1410;
                            text-decoration: none;
                            font-family: 'Figtree', 'Segoe UI', Helvetica, Arial, sans-serif;
                            font-size: 15px;
                            font-weight: 700;
                            letter-spacing: 0.3px;
                            padding: 13px 28px;
                            border-radius: 10px;
                            mso-padding-alt: 0;
                            line-height: 1;">{button_text}</a>
                </td>
              </tr>"""

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>{title}</title>
</head>
<body style="margin: 0; padding: 0; background: #14110E;
             font-family: 'Figtree', 'Segoe UI', Helvetica, Arial, sans-serif;
             color: #F1E9D2;
             -webkit-font-smoothing: antialiased;">
  <!-- Preheader: shows in inbox preview after the subject. Hidden in
       the rendered email itself by the inline styles. -->
  <div style="display: none; max-height: 0; overflow: hidden;
              mso-hide: all; font-size: 1px; line-height: 1px;
              color: #14110E;">{preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         border="0" bgcolor="#14110E" style="background: #14110E;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               border="0" bgcolor="#1A1714" style="max-width: 600px;
               background: #1A1714; border-radius: 14px;">

          <!-- Wordmark — text logo in Syne with system fallbacks. -->
          <tr>
            <td align="center" style="padding: 32px 32px 8px;">
              <span style="font-family: 'Syne', Georgia, 'Times New Roman', serif;
                           font-size: 22px;
                           font-weight: 700;
                           letter-spacing: 0.04em;
                           color: #F1E9D2;">fork</span>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td align="left" style="padding: 12px 32px 4px;">
              <h1 style="margin: 0;
                         font-family: 'Syne', Georgia, 'Times New Roman', serif;
                         font-weight: 700;
                         font-size: 24px;
                         line-height: 1.25;
                         color: #F1E9D2;">{title}</h1>
            </td>
          </tr>

          <!-- Body copy -->
          <tr>
            <td align="left" style="padding: 14px 32px 8px;
                                    font-family: 'Figtree', 'Segoe UI', Helvetica, Arial, sans-serif;
                                    font-size: 15px;
                                    line-height: 1.6;
                                    color: #F1E9D2;">{intro_html}</td>
          </tr>
          {button_html}
          <tr>
            <td align="left" style="padding: 18px 32px 6px;
                                    font-family: 'Figtree', 'Segoe UI', Helvetica, Arial, sans-serif;
                                    font-size: 14px;
                                    line-height: 1.55;
                                    color: #A89A86;">{after_button_html}</td>
          </tr>

          <!-- Footer rule + small print -->
          <tr>
            <td style="padding: 24px 32px 0;">
              <hr style="border: 0; border-top: 1px solid rgba(198,183,155, 0.10); margin: 0;">
            </td>
          </tr>
          <tr>
            <td align="left" style="padding: 18px 32px 28px;
                                    font-family: 'Figtree', 'Segoe UI', Helvetica, Arial, sans-serif;
                                    font-size: 12px;
                                    line-height: 1.55;
                                    color: #6B5F50;">
              {footer_note_html}
              Вопросы — Telegram-канал поддержки:
              <a href="{_TELEGRAM_SUPPORT_URL}"
                 style="color: #A89A86; text-decoration: none;">{_TELEGRAM_SUPPORT_HANDLE}</a><br><br>
              Оператор данных: {OPERATOR_NAME}, г. {OPERATOR_CITY}.<br>
              Это служебное письмо, отвечать на него не нужно.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


# ── Plain-text wrapper ────────────────────────────────────────────────────
# Plain text is what most spam filters score; getting it right is more
# important than the HTML being beautiful. Keep lines under ~72 chars,
# spell out URLs in full (no link text + URL split — many text clients
# won't auto-detect that pattern reliably).

def _render_text(
    *,
    title:        str,
    body:         str,
    button_text:  str | None = None,
    button_url:   str | None = None,
    closing:      str = "",
) -> str:
    cta_block = ""
    if button_text and button_url:
        cta_block = f"\n{button_text}:\n{button_url}\n"
    closing_block = f"\n{closing}\n" if closing else "\n"

    return (
        f"FORK\n\n"
        f"{title}\n"
        f"{'=' * min(len(title), 60)}\n\n"
        f"{body}\n"
        f"{cta_block}"
        f"{closing_block}"
        f"---\n"
        f"Вопросы: {_TELEGRAM_SUPPORT_URL}\n"
        f"Оператор данных: {OPERATOR_NAME}, г. {OPERATOR_CITY}.\n"
        f"Это служебное письмо, отвечать на него не нужно.\n"
    )


# ── Public templates ──────────────────────────────────────────────────────


def confirm_email_template(verify_url: str) -> dict:
    """Email-confirmation message. Sent after register or email change.
    Link is consumed by GET /api/auth/email/verify?token=… which sets
    email_verified=1 and redirects to /?verified=1."""
    title       = "Подтверди email"
    intro_html  = (
        "Спасибо, что попробовал FORK. Нажми на кнопку ниже — "
        "это подтвердит, что email действительно твой, и защитит "
        "аккаунт на случай, если кто-то введёт его по ошибке."
    )
    after_html  = (
        "Если ты не регистрировался — просто проигнорируй это письмо. "
        "Ссылка действует <strong style=\"color:#F1E9D2;\">24 часа</strong>."
    )
    intro_text  = (
        "Спасибо, что попробовал FORK. Открой ссылку ниже — это "
        "подтвердит, что email действительно твой, и защитит аккаунт "
        "на случай, если кто-то введёт его по ошибке."
    )
    closing_txt = (
        "Если ты не регистрировался — просто проигнорируй это письмо. "
        "Ссылка действует 24 часа."
    )

    return {
        "subject": "Подтверди email — FORK",
        "html": _render_html(
            preheader="Один клик, чтобы защитить аккаунт",
            title=title,
            intro_html=intro_html,
            button_text="Подтвердить email",
            button_url=verify_url,
            after_button_html=after_html,
        ),
        "text": _render_text(
            title=title,
            body=intro_text,
            button_text="Подтвердить email",
            button_url=verify_url,
            closing=closing_txt,
        ),
    }


def reset_email_template(reset_url: str) -> dict:
    """Password-reset message. Sent in response to a public POST
    /api/auth/password-reset/request. Link points at the /reset page
    (Phase 3) where the user enters a new password."""
    title       = "Сброс пароля"
    intro_html  = (
        "Кто-то (надеемся, ты) попросил сбросить пароль аккаунта FORK. "
        "Чтобы создать новый пароль, нажми кнопку ниже."
    )
    after_html  = (
        "Если это не ты — просто проигнорируй письмо, текущий пароль "
        "останется прежним. Ссылка действует "
        "<strong style=\"color:#F1E9D2;\">1 час</strong>."
    )
    intro_text  = (
        "Кто-то (надеемся, ты) попросил сбросить пароль аккаунта FORK. "
        "Чтобы создать новый пароль, открой ссылку ниже."
    )
    closing_txt = (
        "Если это не ты — просто проигнорируй письмо, текущий пароль "
        "останется прежним. Ссылка действует 1 час."
    )

    return {
        "subject": "Сброс пароля — FORK",
        "html": _render_html(
            preheader="Создание нового пароля",
            title=title,
            intro_html=intro_html,
            button_text="Создать новый пароль",
            button_url=reset_url,
            after_button_html=after_html,
        ),
        "text": _render_text(
            title=title,
            body=intro_text,
            button_text="Создать новый пароль",
            button_url=reset_url,
            closing=closing_txt,
        ),
    }


def welcome_email_template(app_url: str) -> dict:
    """Welcome message — sent automatically after email_verified flips
    to 1. Light onboarding nudges, no obligations. Single CTA back to
    the app."""
    title       = "Email подтверждён"
    intro_html  = (
        "Аккаунт защищён, всё готово. Несколько советов, чтобы оценки "
        "получались точнее:"
    )
    tips_html   = (
        "<ol style=\"margin: 14px 0 0; padding-left: 22px; color: #F1E9D2;\">"
        "<li style=\"margin-bottom: 8px;\">Снимай еду при естественном "
        "свете — мне проще отличить продукты по цвету.</li>"
        "<li style=\"margin-bottom: 8px;\">Покажи в кадре тарелку, "
        "вилку или руку — это даёт мне масштаб для оценки порции.</li>"
        "<li style=\"margin-bottom: 0;\">Если видишь, что я ошибся, "
        "поправь граммы — каждая правка делает систему чуть точнее.</li>"
        "</ol>"
    )
    intro_text  = "Аккаунт защищён, всё готово. Несколько советов, чтобы оценки получались точнее:"
    tips_text   = (
        "1. Снимай еду при естественном свете — проще отличить продукты по цвету.\n"
        "2. Покажи в кадре тарелку, вилку или руку — это даёт масштаб для оценки порции.\n"
        "3. Если видишь, что система ошиблась, поправь граммы — каждая правка делает её точнее."
    )

    return {
        "subject": "Добро пожаловать в FORK",
        "html": _render_html(
            preheader="Несколько советов для начала",
            title=title,
            intro_html=intro_html + tips_html,
            button_text="Открыть приложение",
            button_url=app_url,
        ),
        "text": _render_text(
            title=title,
            body=intro_text + "\n\n" + tips_text,
            button_text="Открыть приложение",
            button_url=app_url,
        ),
    }
