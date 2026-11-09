const cloudinary = require('cloudinary').v2;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Load all 5 Cloudinary accounts from .env
const accounts = [];

for (let i = 1; i <= 5; i++) {
  const name = process.env[`CLOUD_${i}`];
  const key = process.env[`CLOUD_${i}_KEY`];
  const secret = process.env[`CLOUD_${i}_SECRET`];

  // Validate that all 3 fields are present and key is numeric/alphanumeric (not equal to name)
  if (name && key && secret && key !== name) {
    accounts.push({
      id: i,
      cloud_name: name,
      api_key: key,
      api_secret: secret
    });
  }
}

// Keep round-robin rotation index
let currentAccountIndex = 0;

/**
 * Upload an OMR sheet image (Base64 data URI or Buffer or file path) to Cloudinary
 * using multi-account rotation with automatic fallback.
 */
async function uploadOmrSheet(imageSource, metadata = {}) {
  if (accounts.length === 0) {
    throw new Error('No valid Cloudinary accounts configured in .env');
  }

  let attempts = 0;
  const maxAttempts = accounts.length;
  let lastError = null;

  while (attempts < maxAttempts) {
    const acc = accounts[currentAccountIndex];
    // Rotate to next account for subsequent call
    currentAccountIndex = (currentAccountIndex + 1) % accounts.length;

    try {
      cloudinary.config({
        cloud_name: acc.cloud_name,
        api_key: acc.api_key,
        api_secret: acc.api_secret,
        secure: true
      });

      const uploadOptions = {
        folder: 'garud_omr_sheets',
        resource_type: 'image',
        tags: ['omr_evaluation', metadata.paperId || 'general'],
        context: {
          rollNumber: metadata.rollNumber || 'UNKNOWN',
          paperId: metadata.paperId || ''
        }
      };

      const result = await cloudinary.uploader.upload(imageSource, uploadOptions);

      return {
        url: result.secure_url,
        publicId: result.public_id,
        account: acc.cloud_name
      };
    } catch (err) {
      console.warn(`Cloudinary Account ${acc.id} (${acc.cloud_name}) failed:`, err.message);
      lastError = err;
      attempts++;
    }
  }

  throw new Error(`All Cloudinary accounts failed. Last error: ${lastError ? lastError.message : 'Unknown'}`);
}

/**
 * Delete an OMR sheet image from Cloudinary using the public ID and account name.
 */
async function deleteOmrSheet(publicId, accountName = null) {
  if (!publicId) return { result: 'no_id' };

  let targetAccounts = accounts;
  if (accountName) {
    const matched = accounts.filter(a => a.cloud_name === accountName);
    if (matched.length > 0) {
      targetAccounts = [...matched, ...accounts.filter(a => a.cloud_name !== accountName)];
    }
  }

  for (const acc of targetAccounts) {
    try {
      cloudinary.config({
        cloud_name: acc.cloud_name,
        api_key: acc.api_key,
        api_secret: acc.api_secret,
        secure: true
      });
      const res = await cloudinary.uploader.destroy(publicId);
      if (res && (res.result === 'ok' || res.result === 'not found')) {
        return { success: true, result: res.result, account: acc.cloud_name };
      }
    } catch (err) {
      console.warn(`Could not delete from ${acc.cloud_name}:`, err.message);
    }
  }

  return { success: false, message: 'Could not delete from Cloudinary' };
}

module.exports = {
  uploadOmrSheet,
  deleteOmrSheet,
  getAvailableAccountsCount: () => accounts.length
};

