import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import structlog

from app.config import get_settings

logger = structlog.get_logger()
settings = get_settings()


async def send_invite_email(
    to_email: str,
    to_name: str,
    temp_password: str,
    login_url: str,
    role: str = "member",
):
    """Send an invitation email with temporary credentials."""
    if not settings.smtp_host or not settings.smtp_user or not settings.smtp_password:
        logger.warning("smtp_not_configured", to=to_email)
        return False

    subject = "Voce foi convidado para o Codexfy"

    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#7c3aed,#06b6d4);padding:28px 24px;text-align:center">
            <h1 style="margin:0;font-size:24px;color:#fff">Codexfy</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Code Review com IA</p>
        </div>
        <div style="padding:28px 24px">
            <p style="font-size:16px;margin:0 0 20px">Ola <strong>{to_name}</strong>!</p>
            <p style="margin:0 0 20px;color:#94a3b8">Voce foi convidado como <strong style="color:#e2e8f0">{('Administrador' if role == 'admin' else 'Membro')}</strong> na plataforma Codexfy.</p>

            <div style="background:#1e293b;border-radius:8px;padding:20px;margin:0 0 20px;border:1px solid #334155">
                <p style="margin:0 0 12px;color:#94a3b8;font-size:13px">Suas credenciais de acesso:</p>
                <table style="width:100%;border-collapse:collapse">
                    <tr><td style="padding:6px 0;color:#94a3b8;font-size:13px">Link</td><td style="padding:6px 0;font-weight:600"><a href="{login_url}" style="color:#06b6d4;text-decoration:none">{login_url}</a></td></tr>
                    <tr><td style="padding:6px 0;color:#94a3b8;font-size:13px">E-mail</td><td style="padding:6px 0;font-weight:600;color:#e2e8f0">{to_email}</td></tr>
                    <tr><td style="padding:6px 0;color:#94a3b8;font-size:13px">Senha</td><td style="padding:6px 0;font-weight:700;font-size:18px;color:#7c3aed;font-family:monospace;letter-spacing:2px">{temp_password}</td></tr>
                </table>
            </div>

            <a href="{login_url}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">Acessar Codexfy</a>

            <p style="margin:20px 0 0;color:#64748b;font-size:12px">Recomendamos trocar sua senha apos o primeiro login.</p>
        </div>
    </div>
    """

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"Codexfy <{settings.default_from_email}>"
        msg["To"] = to_email
        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)

        logger.info("invite_email_sent", to=to_email)
        return True
    except Exception as exc:
        logger.error("invite_email_failed", to=to_email, error=str(exc))
        return False
