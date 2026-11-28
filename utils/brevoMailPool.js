const https = require('https');

class BrevoMailPool {
    constructor() {
        this.currentIndex = 0;
    }

    /**
     * Collects all configured Brevo API keys from environment variables (BREVO_1 to BREVO_5)
     */
    getPool() {
        const pool = [];
        for (let i = 1; i <= 5; i++) {
            const key = process.env[`BREVO_${i}`] || process.env[`BREVO_API_KEY_${i}`];
            if (key && typeof key === 'string' && key.trim()) {
                pool.push({
                    id: `BREVO_${i}`,
                    apiKey: key.trim()
                });
            }
        }

        // Fallback for single generic BREVO_API_KEY
        if (pool.length === 0 && process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim()) {
            pool.push({
                id: 'BREVO_PRIMARY',
                apiKey: process.env.BREVO_API_KEY.trim()
            });
        }

        return pool;
    }

    /**
     * Sends an email using the Brevo HTTP API with multi-key round-robin & automatic failover.
     * @param {Object} options
     * @param {string} options.toEmail
     * @param {string} [options.toName]
     * @param {string} options.subject
     * @param {string} options.htmlContent
     * @param {string} [options.textContent]
     * @returns {Promise<{ success: boolean, messageId: string, accountUsed: string }>}
     */
    async sendEmail({ toEmail, toName = '', subject, htmlContent, textContent = '' }) {
        const pool = this.getPool();

        if (pool.length === 0) {
            console.warn('[Brevo Pool Warning] No Brevo API keys configured (BREVO_1..5 in .env).');
            throw new Error('Email service is not configured. Please ask your administrator to configure Brevo API keys.');
        }

        const senderEmail = (process.env.BREVO_SENDER_EMAIL || process.env.SENDER_EMAIL || 'communications@garudclasses.com').trim();
        const senderName = (process.env.BREVO_SENDER_NAME || 'Garud Classes').trim();

        const payload = JSON.stringify({
            sender: {
                name: senderName,
                email: senderEmail
            },
            to: [
                {
                    email: toEmail,
                    name: toName || toEmail.split('@')[0]
                }
            ],
            subject: subject,
            htmlContent: htmlContent,
            textContent: textContent || subject
        });

        const poolSize = pool.length;
        const errors = [];

        // Try accounts starting from currentIndex
        for (let attempt = 0; attempt < poolSize; attempt++) {
            const index = (this.currentIndex + attempt) % poolSize;
            const account = pool[index];

            try {
                const result = await this._sendHttpRequest(account.apiKey, payload);
                // Advance pointer to next account for fair round-robin distribution
                this.currentIndex = (index + 1) % poolSize;
                console.log(`[Brevo Pool] Successfully sent email to "${toEmail}" via account ${account.id} (messageId: ${result.messageId || 'OK'})`);
                return {
                    success: true,
                    messageId: result.messageId || 'OK',
                    accountUsed: account.id
                };
            } catch (err) {
                console.warn(`[Brevo Pool] Account ${account.id} failed: ${err.message}. Trying next available account in pool...`);
                errors.push(`${account.id}: ${err.message}`);
            }
        }

        // If all accounts in pool failed
        const errMsg = `All Brevo email accounts failed (${errors.join('; ')}).`;
        console.error(`[Brevo Pool Error] ${errMsg}`);
        throw new Error(errMsg);
    }

    /**
     * Internal HTTPS request to Brevo Transactional Email REST API v3
     */
    _sendHttpRequest(apiKey, postData) {
        return new Promise((resolve, reject) => {
            const req = https.request('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'api-key': apiKey,
                    'content-type': 'application/json',
                    'accept': 'application/json',
                    'content-length': Buffer.byteLength(postData)
                },
                timeout: 10000
            }, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    let parsed = {};
                    try {
                        parsed = JSON.parse(body);
                    } catch (e) {
                        parsed = { raw: body };
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        return resolve(parsed);
                    }

                    const message = parsed.message || parsed.code || `HTTP ${res.statusCode}`;
                    reject(new Error(message));
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out (10s)'));
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Sends password reset OTP email with styled Garud OMR branding
     */
    async sendOtpEmail({ toEmail, toName, otp, expiresMinutes = 10 }) {
        const subject = `Your Password Reset OTP: ${otp} • Garud OMR`;
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px; color: #0F172A; }
    .card { max-width: 520px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .brand { font-size: 20px; font-weight: 800; color: #2563EB; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    .title { font-size: 18px; font-weight: 700; color: #0F172A; margin: 0 0 12px 0; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
    .otp-box { background: #EFF6FF; border: 2px dashed #93C5FD; border-radius: 10px; padding: 18px; text-align: center; margin: 24px 0; }
    .otp-code { font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #1D4ED8; font-family: 'Courier New', Courier, monospace; }
    .warning { font-size: 12px; color: #64748B; background: #F1F5F9; border-radius: 6px; padding: 10px 14px; margin-top: 20px; }
    .footer { font-size: 11px; color: #94A3B8; text-align: center; margin-top: 24px; border-top: 1px solid #F1F5F9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span>&#129534; Garud OMR</span>
    </div>
    <h2 class="title">Password Reset Request</h2>
    <p class="text">Hello <strong>${escapeHtml(toName || 'Student')}</strong>,</p>
    <p class="text">We received a request to reset your password for Garud OMR. Use the One-Time Password (OTP) below to complete your password reset:</p>
    
    <div class="otp-box">
      <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #3B82F6; margin-bottom: 6px; letter-spacing: 1px;">Your One-Time Password</div>
      <div class="otp-code">${otp}</div>
    </div>

    <p class="text" style="font-size: 13px;">This code will expire in <strong>${expiresMinutes} minutes</strong>. Please do not share this OTP with anyone.</p>
    
    <div class="warning">
      <strong>Didn't request this?</strong> If you did not ask to reset your password, please ignore this email. Your current password remains safe and unchanged.
    </div>

    <div class="footer">
      &copy; ${new Date().getFullYear()} Garud OMR Examination & Evaluation System. All rights reserved.
    </div>
  </div>
</body>
</html>
        `;

        const textContent = `Your Garud OMR password reset OTP is: ${otp}. It expires in ${expiresMinutes} minutes. If you did not request this, please ignore.`;

        return this.sendEmail({
            toEmail,
            toName,
            subject,
            htmlContent,
            textContent
        });
    }

    /**
     * Sends WhatsApp Result Dispatch Authorization OTP email to administrator
     */
    async sendDispatchOtpEmail({ toEmail, toName, otp, paperTitle, totalStudents, expiresMinutes = 10 }) {
        const subject = `🔐 Authorization OTP: Send WhatsApp Results • ${paperTitle || 'OMR Exam'}`;
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px; color: #0F172A; }
    .card { max-width: 520px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .brand { font-size: 20px; font-weight: 800; color: #16A34A; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    .title { font-size: 18px; font-weight: 700; color: #0F172A; margin: 0 0 12px 0; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
    .paper-info { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 13px; color: #334155; }
    .otp-box { background: #F0FDF4; border: 2px dashed #86EFAC; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0; }
    .otp-code { font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #15803D; font-family: 'Courier New', Courier, monospace; }
    .warning { font-size: 12px; color: #9A3412; background: #FFF7ED; border-left: 3px solid #F97316; border-radius: 4px; padding: 10px 14px; margin-top: 20px; }
    .footer { font-size: 11px; color: #94A3B8; text-align: center; margin-top: 24px; border-top: 1px solid #F1F5F9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span>🦅 Garud Classes OMR</span>
    </div>
    <h2 class="title">WhatsApp Result Dispatch Authorization</h2>
    <p class="text">Hello <strong>${escapeHtml(toName || 'Admin')}</strong>,</p>
    <p class="text">A request was made from your session to send OMR evaluation scorecards via WhatsApp to students.</p>

    <div class="paper-info">
      <div><strong>Paper:</strong> ${escapeHtml(paperTitle)}</div>
      <div><strong>Total Evaluated Copies:</strong> ${totalStudents}</div>
      <div><strong>Security:</strong> HMAC-SHA256 Encrypted Portal Link</div>
    </div>

    <div class="otp-box">
      <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #16A34A; margin-bottom: 6px; letter-spacing: 1px;">Your Verification Code</div>
      <div class="otp-code">${otp}</div>
    </div>

    <p class="text" style="font-size: 13px;">This code will expire in <strong>${expiresMinutes} minutes</strong>. It authorizes automated dispatch with anti-blocking intervals.</p>

    <div class="warning">
      <strong>⚠️ Important Notice:</strong> If you did not initiate this dispatch request, do not share or enter this code. Your WhatsApp account remains secure.
    </div>

    <div class="footer">
      &copy; ${new Date().getFullYear()} Garud Classes Examination & Evaluation System. All rights reserved.
    </div>
  </div>
</body>
</html>
        `;

        const textContent = `Your Garud Classes WhatsApp result dispatch OTP for "${paperTitle}" (${totalStudents} students) is: ${otp}. Valid for ${expiresMinutes} minutes.`;

        return this.sendEmail({
            toEmail,
            toName,
            subject,
            htmlContent,
            textContent
        });
    }

    /**
     * Sends Two-Factor Authentication (2FA) login OTP email to Admin / Teacher
     */
    async sendTwoFactorOtpEmail({ toEmail, toName, otp, role = 'admin', expiresMinutes = 10 }) {
        const roleLabel = role === 'admin' ? 'Administrator' : 'Teacher';
        const subject = `🔐 ${otp} is your 2-Factor Authentication Code • Garud OMR`;
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px; color: #0F172A; }
    .card { max-width: 520px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .brand { font-size: 20px; font-weight: 800; color: #2563EB; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    .title { font-size: 18px; font-weight: 700; color: #0F172A; margin: 0 0 12px 0; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px 0; }
    .role-badge { display: inline-block; background: #EFF6FF; border: 1px solid #BFDBFE; color: #1D4ED8; font-weight: 700; font-size: 12px; padding: 3px 10px; border-radius: 999px; margin-bottom: 12px; }
    .otp-box { background: #EFF6FF; border: 2px dashed #93C5FD; border-radius: 10px; padding: 18px; text-align: center; margin: 24px 0; }
    .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #1D4ED8; font-family: 'Courier New', Courier, monospace; }
    .warning { font-size: 12px; color: #991B1B; background: #FEF2F2; border-left: 3px solid #EF4444; border-radius: 4px; padding: 10px 14px; margin-top: 20px; line-height: 1.5; }
    .footer { font-size: 11px; color: #94A3B8; text-align: center; margin-top: 24px; border-top: 1px solid #F1F5F9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span>🦅 Garud OMR • Security Center</span>
    </div>
    <span class="role-badge">${escapeHtml(roleLabel)} Portal Login</span>
    <h2 class="title">Two-Factor Authentication (2FA) Code</h2>
    <p class="text">Hello <strong>${escapeHtml(toName || 'User')}</strong>,</p>
    <p class="text">A sign-in attempt was initiated for your <strong>${escapeHtml(roleLabel)}</strong> account. To complete your login securely, enter the One-Time Password (OTP) below:</p>
    
    <div class="otp-box">
      <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #3B82F6; margin-bottom: 6px; letter-spacing: 1px;">Your 2FA Verification Code</div>
      <div class="otp-code">${otp}</div>
    </div>

    <p class="text" style="font-size: 13px;">This verification code is valid for <strong>${expiresMinutes} minutes</strong> and can only be used once. Never share this code with anyone.</p>
    
    <div class="warning">
      <strong>Didn't attempt to sign in?</strong> If you did not make this login attempt, someone may know your password. Please sign in and change your password immediately or contact your administrator.
    </div>

    <div class="footer">
      &copy; ${new Date().getFullYear()} Garud Classes OMR Examination & Evaluation System. All rights reserved.
    </div>
  </div>
</body>
</html>
        `;

        const textContent = `Your Garud OMR 2-Factor Authentication (2FA) login code is: ${otp}. It expires in ${expiresMinutes} minutes. If you did not attempt to sign in, please secure your account immediately.`;

        return this.sendEmail({
            toEmail,
            toName,
            subject,
            htmlContent,
            textContent
        });
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = new BrevoMailPool();
