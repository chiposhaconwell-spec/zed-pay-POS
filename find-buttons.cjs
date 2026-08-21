const fs = require('fs');
const content = fs.readFileSync('src/components/BillingTerminal.tsx', 'utf-8');
const regex = /<button[^>]*>/g;
let match;
while ((match = regex.exec(content)) !== null) {
  if (!match[0].includes('type="button"') && !match[0].includes('type="submit"')) {
    console.log(`Line ${content.substring(0, match.index).split('\n').length}: ${match[0]}`);
  }
}
