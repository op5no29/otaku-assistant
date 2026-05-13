function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
}

function splitResponseIntoChunks(text, maxLength) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let cutIndex = remaining.lastIndexOf('\n', maxLength);
    if (cutIndex < Math.floor(maxLength * 0.5)) {
      cutIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (cutIndex < Math.floor(maxLength * 0.3)) {
      cutIndex = maxLength;
    }

    chunks.push(remaining.slice(0, cutIndex).trim());
    remaining = remaining.slice(cutIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

module.exports = {
  truncateText,
  splitResponseIntoChunks
};
