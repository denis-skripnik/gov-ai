import http from 'http';
import "dotenv/config";
import fs from 'fs';
import path from 'path';
import url from 'url';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PAGE_PORT || 3100;
const REPORTS_DIR = path.join(process.cwd(), 'reports');

// ============================================================================
// i18n Support
// ============================================================================

const I18N = {
  en: {
    pageTitle: 'DAO Governance Reports',
    reportsCount: 'Total reports',
    noReports: 'No reports available',
    backToList: 'Back to list',
    file: 'File',
    notFound: 'Page not found',
    backToHome: 'Back to home',
    sourceInfo: 'Source Information',
    url: 'URL',
    fetchedAt: 'Fetched at',
    sourceType: 'Source type',
    extractedData: 'Extracted Data',
    votingOptions: 'Voting Options',
    currentResults: 'Current Results',
    metadata: 'Metadata',
    analysis: 'Analysis',
    summary: 'Summary',
    keyChanges: 'Key Changes',
    risks: 'Risks',
    benefits: 'Benefits',
    unknowns: 'Unknown Factors',
    evidenceQuotes: 'Evidence Quotes',
    recommendation: 'Recommendation',
    suggestedOption: 'Suggested option',
    confidence: 'Confidence level',
    reasoning: 'Reasoning',
    conflicts: 'Conflicts with user principles',
    limitations: 'Limitations and Warnings',
    voteResults: 'Vote Results',
    voteStats: 'Vote Statistics',
    option: 'Option',
    votes: 'Votes',
    percent: 'Percent',
    type: 'Type',
    voters: 'Voters',
    modified: 'Modified',
    size: 'Size',
    reportTitle: 'Report',
    verification: 'Verification',
    verified: 'Verified',
    validators: 'Validators',
    model: 'Model',
    merkleRoot: 'Merkle root',
    requestId: 'Request ID',
    auction: 'Auction',
    status: 'Status',
    bidsPlaced: 'Bids placed',
    bidsRevealed: 'Bids revealed',
    auctionAddress: 'Auction address',
    bidder: 'Bidder'
  },
  ru: {
    pageTitle: 'Отчёты DAO Governance',
    reportsCount: 'Всего отчётов',
    noReports: 'Нет доступных отчётов',
    backToList: 'Назад к списку',
    file: 'Файл',
    notFound: 'Страница не найдена',
    backToHome: 'Вернуться на главную',
    sourceInfo: 'Информация об источнике',
    url: 'URL',
    fetchedAt: 'Получено',
    sourceType: 'Тип источника',
    extractedData: 'Извлечённые данные',
    votingOptions: 'Варианты голосования',
    currentResults: 'Текущие результаты',
    metadata: 'Метаданные',
    analysis: 'Анализ',
    summary: 'Резюме',
    keyChanges: 'Ключевые изменения',
    risks: 'Риски',
    benefits: 'Преимущества',
    unknowns: 'Неизвестные факторы',
    evidenceQuotes: 'Цитаты из предложения',
    recommendation: 'Рекомендация',
    suggestedOption: 'Рекомендуемый вариант',
    confidence: 'Уровень уверенности',
    reasoning: 'Обоснование',
    conflicts: 'Конфликты с принципами пользователя',
    limitations: 'Ограничения и предупреждения',
    voteResults: 'Результаты голосования',
    voteStats: 'Статистика голосования',
    option: 'Вариант',
    votes: 'Голосов',
    percent: 'Процент',
    type: 'Тип',
    voters: 'Голосующих',
    modified: 'Изменён',
    size: 'Размер',
    reportTitle: 'Отчёт',
    verification: 'Верификация',
    verified: 'Верифицировано',
    validators: 'Валидаторы',
    model: 'Модель',
    merkleRoot: 'Корень Меркла',
    requestId: 'ID запроса',
    auction: 'Аукцион',
    status: 'Статус',
    bidsPlaced: 'Ставок размещено',
    bidsRevealed: 'Ставок раскрыто',
    auctionAddress: 'Адрес аукциона',
    bidder: 'Участник'
  }
};

// ============================================================================
// Markdown Formatter
// ============================================================================

function formatMarkdown(text) {
  if (!text) return '';
  
  let html = text;
  
  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  
  // Code blocks
  html = html.replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>');
  
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  
  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<h') && !html.startsWith('<p>')) {
    html = '<p>' + html + '</p>';
  }
  
  return html;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatNumber(num) {
  const number = typeof num === 'string' ? parseFloat(num) : num;
  if (isNaN(number)) return num;
  
  // Format large numbers with separators
  if (number >= 1e12) {
    return (number / 1e12).toFixed(2) + 'T';
  } else if (number >= 1e9) {
    return (number / 1e9).toFixed(2) + 'B';
  } else if (number >= 1e6) {
    return (number / 1e6).toFixed(2) + 'M';
  } else if (number >= 1e3) {
    return (number / 1e3).toFixed(2) + 'K';
  }
  
  return number.toLocaleString('ru-RU');
}

// ============================================================================
// Report Formatters
// ============================================================================

function formatVoteResults(results, t) {
  if (!results) return '<p>Нет данных о результатах голосования</p>';
  
  let html = '<div class="vote-results">';
  
  // Format 1: DAO DAO (votes object)
  if (results.votes) {
    html += `<h3>${t.voteResults}</h3>`;
    if (results.status) {
      html += `<div class="badge badge-${results.status}">${results.status}</div>`;
    }
    
    // Calculate total votes and percentages
    const voteEntries = Object.entries(results.votes);
    const totalVotes = voteEntries.reduce((sum, [, count]) => {
      const num = typeof count === 'string' ? parseFloat(count) : count;
      return sum + (isNaN(num) ? 0 : num);
    }, 0);
    
    html += '<table class="votes-table">';
    html += `<thead><tr><th>${t.option}</th><th>${t.votes}</th><th>${t.percent}</th></tr></thead>`;
    html += '<tbody>';
    for (const [option, count] of voteEntries) {
      const num = typeof count === 'string' ? parseFloat(count) : count;
      const percent = totalVotes > 0 ? ((num / totalVotes) * 100).toFixed(2) : 0;
      const formattedCount = formatNumber(count);
      
      html += `<tr>
        <td><span class="vote-type vote-type-${option}">${option}</span></td>
        <td>${formattedCount}</td>
        <td>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${percent}%">${percent}%</div>
          </div>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  
  // Format 2: Tally (voteStats array)
  if (results.voteStats && Array.isArray(results.voteStats)) {
    html += `<h3>${t.voteStats}</h3>`;
    html += '<table class="votes-table">';
    html += `<thead><tr><th>${t.type}</th><th>${t.votes}</th><th>${t.voters}</th><th>${t.percent}</th></tr></thead>`;
    html += '<tbody>';
    for (const stat of results.voteStats) {
      const percent = stat.percent ? stat.percent.toFixed(2) + '%' : 'N/A';
      const formattedVotes = formatNumber(stat.votesCount);
      const formattedVoters = stat.votersCount ? stat.votersCount.toLocaleString('ru-RU') : 'N/A';
      
      html += `<tr>
        <td><span class="vote-type vote-type-${stat.type}">${stat.type}</span></td>
        <td>${formattedVotes}</td>
        <td>${formattedVoters}</td>
        <td>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${stat.percent || 0}%">${percent}</div>
          </div>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  
  html += '</div>';
  return html;
}

function formatInput(input, t) {
  if (!input) return '';
  
  let html = '<div class="section input-section">';
  html += `<h2>${t.sourceInfo}</h2>`;
  
  if (input.url) {
    html += `<p><strong>${t.url}:</strong> <a href="${input.url}" target="_blank">${input.url}</a></p>`;
  }
  
  if (input.fetched_at) {
    const date = new Date(input.fetched_at);
    html += `<p><strong>${t.fetchedAt}:</strong> ${date.toLocaleString('ru-RU')}</p>`;
  }
  
  if (input.source_type) {
    html += `<p><strong>${t.sourceType}:</strong> <span class="badge">${input.source_type}</span></p>`;
  }
  
  html += '</div>';
  return html;
}

function formatExtracted(extracted, t) {
  if (!extracted) return '';
  
  let html = '<div class="section extracted-section">';
  html += `<h2>${t.extractedData}</h2>`;
  
  if (extracted.title) {
    html += `<h3>${extracted.title}</h3>`;
  }
  
  if (extracted.body) {
    html += '<div class="proposal-body">';
    html += formatMarkdown(extracted.body);
    html += '</div>';
  }
  
  if (extracted.options && Array.isArray(extracted.options)) {
    html += `<h3>${t.votingOptions}</h3>`;
    html += '<ul class="options-list">';
    for (const option of extracted.options) {
      html += `<li>${option}</li>`;
    }
    html += '</ul>';
  }
  
  if (extracted.current_results) {
    html += formatVoteResults(extracted.current_results, t);
  }
  
  if (extracted.metadata) {
    html += '<details class="metadata">';
    html += `<summary>${t.metadata}</summary>`;
    html += '<pre>' + JSON.stringify(extracted.metadata, null, 2) + '</pre>';
    html += '</details>';
  }
  
  html += '</div>';
  return html;
}

function formatAnalysis(analysis, t) {
  if (!analysis) return '';
  
  let html = '<div class="section analysis-section">';
  html += `<h2>${t.analysis}</h2>`;
  
  if (analysis.summary) {
    html += '<div class="summary">';
    html += `<h3>${t.summary}</h3>`;
    html += formatMarkdown(analysis.summary);
    html += '</div>';
  }
  
  if (analysis.key_changes && Array.isArray(analysis.key_changes) && analysis.key_changes.length > 0) {
    html += '<div class="key-changes">';
    html += `<h3>${t.keyChanges}</h3>`;
    html += '<ol>';
    for (const change of analysis.key_changes) {
      html += `<li>${formatMarkdown(change)}</li>`;
    }
    html += '</ol>';
    html += '</div>';
  }
  
  if (analysis.risks && Array.isArray(analysis.risks) && analysis.risks.length > 0) {
    html += '<div class="risks">';
    html += `<h3>⚠️ ${t.risks}</h3>`;
    html += '<ul>';
    for (const risk of analysis.risks) {
      html += `<li>${formatMarkdown(risk)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }
  
  if (analysis.benefits && Array.isArray(analysis.benefits) && analysis.benefits.length > 0) {
    html += '<div class="benefits">';
    html += `<h3>⚠️ ${t.benefits}</h3>`;
    html += '<ul>';
    for (const benefit of analysis.benefits) {
      html += `<li>${formatMarkdown(benefit)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }

  if (analysis.unknowns && Array.isArray(analysis.unknowns) && analysis.unknowns.length > 0) {
    html += '<div class="unknowns">';
    html += `<h3>❓ ${t.unknowns}</h3>`;
    html += '<ul>';
    for (const unknown of analysis.unknowns) {
      html += `<li>${formatMarkdown(unknown)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }
  
  if (analysis.evidence_quotes && Array.isArray(analysis.evidence_quotes) && analysis.evidence_quotes.length > 0) {
    html += '<div class="evidence">';
    html += `<h3>${t.evidenceQuotes}</h3>`;
    for (const quote of analysis.evidence_quotes) {
      html += `<blockquote>${formatMarkdown(quote)}</blockquote>`;
    }
    html += '</div>';
  }
  
  html += '</div>';
  return html;
}

function formatRecommendation(recommendation, t) {
  if (!recommendation) return '';
  
  let html = '<div class="section recommendation-section">';
  html += `<h2>${t.recommendation}</h2>`;
  
  if (recommendation.suggested_option) {
    html += `<div class="suggested-option">`;
    html += `<strong>${t.suggestedOption}:</strong> <span class="highlight">${recommendation.suggested_option}</span>`;
    html += `</div>`;
  }
  
  if (recommendation.confidence) {
    const confidenceClass = `confidence-${recommendation.confidence}`;
    html += `<div class="confidence ${confidenceClass}">`;
    html += `<strong>${t.confidence}:</strong> <span class="badge">${recommendation.confidence}</span>`;
    html += `</div>`;
  }
  
  if (recommendation.reasoning) {
    html += '<div class="reasoning">';
    html += `<h3>${t.reasoning}</h3>`;
    html += formatMarkdown(recommendation.reasoning);
    html += '</div>';
  }
  
  if (recommendation.conflicts_with_user_principles && Array.isArray(recommendation.conflicts_with_user_principles) && recommendation.conflicts_with_user_principles.length > 0) {
    html += '<div class="conflicts">';
    html += `<h3>⚠️ ${t.conflicts}</h3>`;
    html += '<ul>';
    for (const conflict of recommendation.conflicts_with_user_principles) {
      html += `<li>${formatMarkdown(conflict)}</li>`;
    }
    html += '</ul>';
    html += '</div>';
  }
  
  html += '</div>';
  return html;
}

function formatLimitations(limitations, t) {
  if (!limitations || !Array.isArray(limitations) || limitations.length === 0) return '';
  
  let html = '<div class="section limitations-section">';
  html += `<h2>⚠️ ${t.limitations}</h2>`;
  html += '<ul class="limitations-list">';
  for (const limitation of limitations) {
    html += `<li>${formatMarkdown(limitation)}</li>`;
  }
  html += '</ul>';
  html += '</div>';
  return html;
}

function formatVerification(ambient, t) {
  if (!ambient) return '';
  
  let html = '<div class="section verification">';
  html += `<h2>${t.verification}</h2>`;
  
  if (typeof ambient.verified !== 'undefined') {
    const verifiedClass = ambient.verified ? '' : 'false';
    const verifiedText = ambient.verified ? 'Yes' : 'No';
    html += `<p><strong>${t.verified}:</strong> <span class="verified-badge ${verifiedClass}">${verifiedText}</span></p>`;
  }
  
  if (ambient.verified_by_validators) {
    html += `<p><strong>${t.validators}:</strong> ${ambient.verified_by_validators}</p>`;
  }
  
  if (ambient.model) {
    html += `<p><strong>${t.model}:</strong> ${ambient.model}</p>`;
  }
  
  if (ambient.merkle_root) {
    html += `<p><strong>${t.merkleRoot}:</strong> <code>${ambient.merkle_root}</code></p>`;
  }
  
  if (ambient.request_id) {
    html += `<p><strong>${t.requestId}:</strong> <code>${ambient.request_id}</code></p>`;
  }
  
  if (ambient.auction) {
    html += `<h3>${t.auction}</h3>`;
    
    if (ambient.auction.status) {
      html += `<p><strong>${t.status}:</strong> ${ambient.auction.status}</p>`;
    }
    
    if (ambient.auction.bids) {
      if (typeof ambient.auction.bids.placed !== 'undefined') {
        html += `<p><strong>${t.bidsPlaced}:</strong> ${ambient.auction.bids.placed}</p>`;
      }
      if (typeof ambient.auction.bids.revealed !== 'undefined') {
        html += `<p><strong>${t.bidsRevealed}:</strong> ${ambient.auction.bids.revealed}</p>`;
      }
    }
    
    if (ambient.auction.address) {
      html += `<p><strong>${t.auctionAddress}:</strong> <a href="${ambient.auction.address}" rel="noreferrer" target="_blank">${ambient.auction.address}</a></p>`;
    }
  }
  
  if (ambient.bidder) {
    html += `<p><strong>${t.bidder}:</strong> <a href="${ambient.bidder}" rel="noreferrer" target="_blank">${ambient.bidder}</a></p>`;
  }
  
  html += '</div>';
  return html;
}

// ============================================================================
// HTML Templates
// ============================================================================

function getStyles() {
  return `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    
    header {
      border-bottom: 3px solid #007bff;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    
    .lang-switcher {
      float: right;
      margin-top: 10px;
    }
    
    .lang-switcher a {
      display: inline-block;
      padding: 6px 12px;
      margin-left: 8px;
      background: #007bff;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      font-size: 0.9em;
      font-weight: 600;
      transition: background 0.3s ease;
    }
    
    .lang-switcher a:hover {
      background: #0056b3;
    }
    
    .lang-switcher a.active {
      background: #0056b3;
    }
    
    h1 {
      color: #007bff;
      font-size: 2.5em;
      margin-bottom: 10px;
    }
    
    h2 {
      color: #0056b3;
      font-size: 1.8em;
      margin-top: 30px;
      margin-bottom: 15px;
      border-bottom: 2px solid #e9ecef;
      padding-bottom: 10px;
    }
    
    h3 {
      color: #495057;
      font-size: 1.3em;
      margin-top: 20px;
      margin-bottom: 10px;
    }
    
    .report-list {
      list-style: none;
    }
    
    .report-list li {
      background: #f8f9fa;
      margin-bottom: 15px;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #007bff;
      transition: all 0.3s ease;
    }
    
    .report-list li:hover {
      background: #e9ecef;
      transform: translateX(5px);
    }
    
    .report-list a {
      color: #007bff;
      text-decoration: none;
      font-size: 1.2em;
      font-weight: 500;
    }
    
    .report-list a:hover {
      text-decoration: underline;
    }
    
    .report-meta {
      color: #6c757d;
      font-size: 0.9em;
      margin-top: 5px;
    }
    
    .section {
      margin-bottom: 40px;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 6px;
    }
    
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 600;
      background: #007bff;
      color: white;
    }
    
    .badge-open {
      background: #28a745;
    }
    
    .badge-closed {
      background: #dc3545;
    }
    
    .badge-executed {
      background: #6c757d;
    }
    
    .votes-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
      background: white;
    }
    
    .votes-table th,
    .votes-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #dee2e6;
    }
    
    .votes-table th {
      background: #007bff;
      color: white;
      font-weight: 600;
    }
    
    .votes-table tr:hover {
      background: #f8f9fa;
    }
    
    .vote-type {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.85em;
    }
    
    .vote-type-for {
      background: #d4edda;
      color: #155724;
    }
    
    .vote-type-against {
      background: #f8d7da;
      color: #721c24;
    }
    
    .vote-type-abstain {
      background: #fff3cd;
      color: #856404;
    }
    
    .progress-bar {
      background: #e9ecef;
      border-radius: 4px;
      overflow: hidden;
      height: 24px;
      position: relative;
    }
    
    .progress-fill {
      background: linear-gradient(90deg, #007bff, #0056b3);
      color: white;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85em;
      font-weight: 600;
      min-width: 50px;
    }
    
    .proposal-body {
      background: white;
      padding: 20px;
      border-radius: 6px;
      margin: 15px 0;
      border-left: 4px solid #007bff;
    }
    
    .options-list {
      list-style: none;
      margin: 15px 0;
    }
    
    .options-list li {
      background: white;
      padding: 12px 20px;
      margin-bottom: 10px;
      border-radius: 6px;
      border-left: 3px solid #28a745;
    }
    
    .summary {
      background: #e7f3ff;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #007bff;
      margin: 15px 0;
    }
    
    .key-changes ol {
      margin-left: 20px;
      margin-top: 10px;
    }
    
    .key-changes li {
      margin-bottom: 10px;
      padding-left: 10px;
    }
    
    .risks {
      background: #fff3cd;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #ffc107;
      margin: 15px 0;
    }
    
    .risks ul {
      margin-left: 20px;
      margin-top: 10px;
    }
    
    .risks li {
      margin-bottom: 8px;
    }

    .benefits {
  background: #d1e7dd;
  padding: 20px;
  border-radius: 6px;
  border-left: 4px solid #198754;
  margin: 15px 0;
}

.benefits ul {
  margin-left: 20px;
  margin-top: 10px;
}

.benefits li {
  margin-bottom: 8px;
}

    .unknowns {
      background: #f8d7da;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #dc3545;
      margin: 15px 0;
    }
    
    .unknowns ul {
      margin-left: 20px;
      margin-top: 10px;
    }
    
    .unknowns li {
      margin-bottom: 8px;
    }
    
    blockquote {
      background: white;
      border-left: 4px solid #6c757d;
      padding: 15px 20px;
      margin: 10px 0;
      font-style: italic;
      color: #495057;
    }
    
    .suggested-option {
      background: #d4edda;
      padding: 15px 20px;
      border-radius: 6px;
      margin: 15px 0;
      font-size: 1.1em;
    }
    
    .highlight {
      background: #28a745;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-weight: 600;
    }
    
    .confidence {
      margin: 15px 0;
      padding: 10px 15px;
      border-radius: 6px;
    }
    
    .confidence-high {
      background: #d4edda;
    }
    
    .confidence-medium {
      background: #fff3cd;
    }
    
    .confidence-low {
      background: #f8d7da;
    }
    
    .reasoning {
      background: white;
      padding: 20px;
      border-radius: 6px;
      margin: 15px 0;
    }
    
    .conflicts {
      background: #f8d7da;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #dc3545;
      margin: 15px 0;
    }
    
    .conflicts ul {
      margin-left: 20px;
      margin-top: 10px;
    }
    
    .limitations-section {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
    }
    
    .limitations-list {
      margin-left: 20px;
      margin-top: 10px;
    }
    
    .limitations-list li {
      margin-bottom: 8px;
    }
    
    .back-link {
      display: inline-block;
      margin-bottom: 20px;
      padding: 10px 20px;
      background: #007bff;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      transition: background 0.3s ease;
    }
    
    .back-link:hover {
      background: #0056b3;
    }
    
    .metadata {
      margin-top: 20px;
      background: white;
      padding: 15px;
      border-radius: 6px;
    }
    
    .metadata summary {
      cursor: pointer;
      font-weight: 600;
      color: #007bff;
    }
    
    .metadata pre {
      margin-top: 10px;
      background: #f8f9fa;
      padding: 15px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.9em;
    }
    
    .verification {
      background: #e9ecef;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #6c757d;
      margin-bottom: 40px;
    }
    
    .verification p {
      margin: 8px 0;
      line-height: 1.8;
    }
    
    .verification strong {
      color: #495057;
      min-width: 140px;
      display: inline-block;
    }
    
    .verification .verified-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 600;
      background: #28a745;
      color: white;
    }
    
    .verification .verified-badge.false {
      background: #dc3545;
    }
    
    code {
      background: #f8f9fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
    }
    
    pre code {
      background: none;
      padding: 0;
    }
    
    a {
      color: #007bff;
    }
    
    a:hover {
      color: #0056b3;
    }
    
    .error-page {
      text-align: center;
      padding: 60px 20px;
    }
    
    .error-page h1 {
      font-size: 4em;
      color: #dc3545;
    }
    
    .error-page p {
      font-size: 1.2em;
      color: #6c757d;
      margin: 20px 0;
    }
  `;
}

function buildLangSwitcher(currentUrl, currentLang) {
  const parsedUrl = new URL(currentUrl, 'http://localhost');
  const enUrl = new URL(parsedUrl);
  const ruUrl = new URL(parsedUrl);
  
  enUrl.searchParams.set('lang', 'en');
  ruUrl.searchParams.set('lang', 'ru');
  
  const enHref = enUrl.pathname + enUrl.search;
  const ruHref = ruUrl.pathname + ruUrl.search;
  
  const enClass = currentLang === 'en' ? 'active' : '';
  const ruClass = currentLang === 'ru' ? 'active' : '';
  
  return `
    <div class="lang-switcher">
      <a href="${enHref}" class="${enClass}">EN</a>
      <a href="${ruHref}" class="${ruClass}">RU</a>
    </div>
  `;
}

function generateMainPage(files, lang, currentUrl) {
  const t = I18N[lang];
  const fileItems = files.map(file => {
    const fileName = file.name;
    const stats = file.stats;
    const date = stats ? new Date(stats.mtime).toLocaleString('ru-RU') : '';
    const size = stats ? (stats.size / 1024).toFixed(2) + ' KB' : '';
    
    return `
      <li>
        <a href="/report/${encodeURIComponent(fileName)}?lang=${lang}">${fileName}</a>
        <div class="report-meta">
          ${date ? `${t.modified}: ${date}` : ''} 
          ${size ? `| ${t.size}: ${size}` : ''}
        </div>
      </li>
    `;
  }).join('');
  
  return `
    <!DOCTYPE html>
    <html lang="${lang}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.pageTitle}</title>
      <style>${getStyles()}</style>
    </head>
    <body>
      <div class="container">
        <header>
          ${buildLangSwitcher(currentUrl, lang)}
          <h1>📊 ${t.pageTitle}</h1>
          <p>${t.reportsCount}: ${files.length}</p>
        </header>
        <main>
          ${files.length > 0 ? `<ul class="report-list">${fileItems}</ul>` : `<p>${t.noReports}</p>`}
        </main>
      </div>
    </body>
    </html>
  `;
}

function generateReportPage(report, filename, lang, currentUrl) {
  const t = I18N[lang];
  const title = report.extracted?.title || t.reportTitle;
  
  return `
    <!DOCTYPE html>
    <html lang="${lang}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - ${t.reportTitle}</title>
      <style>${getStyles()}</style>
    </head>
    <body>
      <div class="container">
        <a href="/?lang=${lang}" class="back-link">← ${t.backToList}</a>
        <header>
          ${buildLangSwitcher(currentUrl, lang)}
          <h1>${title}</h1>
          <p class="report-meta">${t.file}: ${filename}</p>
        </header>
        <article>
          ${formatInput(report.input, t)}
          ${formatExtracted(report.extracted, t)}
          ${formatAnalysis(report.analysis, t)}
          ${formatRecommendation(report.recommendation, t)}
          ${formatLimitations(report.limitations, t)}
          ${formatVerification(report.__ambient, t)}
        </article>
      </div>
    </body>
    </html>
  `;
}

function generate404Page(lang, currentUrl) {
  const t = I18N[lang];
  return `
    <!DOCTYPE html>
    <html lang="${lang}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>404 - ${t.notFound}</title>
      <style>${getStyles()}</style>
    </head>
    <body>
      <div class="container error-page">
        ${buildLangSwitcher(currentUrl, lang)}
        <h1>404</h1>
        <p>${t.notFound}</p>
        <a href="/?lang=${lang}" class="back-link">← ${t.backToHome}</a>
      </div>
    </body>
    </html>
  `;
}

// ============================================================================
// File System Handlers
// ============================================================================

function getReportFiles() {
  try {
    const files = fs.readdirSync(REPORTS_DIR);
    const jsonFiles = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(REPORTS_DIR, file);
        const stats = fs.statSync(filePath);
        return { name: file, stats };
      })
      .sort((a, b) => b.stats.mtime - a.stats.mtime); // Sort by modification time, newest first
    
    return jsonFiles;
  } catch (error) {
    console.error('Error reading reports directory:', error);
    return [];
  }
}

function readReportFile(filename) {
  try {
    const filePath = path.join(REPORTS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error reading report file:', error);
    return null;
  }
}

// ============================================================================
// HTTP Server
// ============================================================================

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const lang = parsedUrl.query.lang === 'ru' ? 'ru' : 'en';
  
  // Route: Main page
  if (pathname === '/') {
    const files = getReportFiles();
    const html = generateMainPage(files, lang, req.url);
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  
  // Route: Report page
  if (pathname.startsWith('/report/')) {
    const filename = decodeURIComponent(pathname.replace('/report/', ''));
    
    // Security check: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generate404Page(lang, req.url));
      return;
    }
    
    const report = readReportFile(filename);
    
    if (report) {
      const html = generateReportPage(report, filename, lang, req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generate404Page(lang, req.url));
    }
    return;
  }
  
  // Route: 404
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(generate404Page(lang, req.url));
});

server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📁 Serving reports from: ${REPORTS_DIR}`);
  console.log(`📊 Available reports: ${getReportFiles().length}`);
});
