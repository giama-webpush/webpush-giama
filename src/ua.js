'use strict';
// Detección simple de dispositivo / SO / navegador a partir del User-Agent (sin dependencias).
function parseUA(ua = '') {
  const s = String(ua);
  let os = 'Otro';
  if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Macintosh/i.test(s) && /Mobile\//.test(s)) os = 'iOS';    // iPadOS
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  let browser = 'Otro';
  if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/CriOS/i.test(s)) browser = 'Chrome';
  else if (/Chrome|Chromium/i.test(s)) browser = 'Chrome';
  else if (/Safari/i.test(s)) browser = 'Safari';

  let device = 'desktop';
  if (/iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android/i.test(s)) device = 'mobile';
  else if (/Macintosh/i.test(s) && /Mobile\//.test(s)) device = 'tablet';
  return { device, os, browser };
}
module.exports = { parseUA };
