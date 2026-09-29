const puppeteer = require('puppeteer');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  
  HH_TOKEN: process.env.HH_TOKEN || '',
  HH_API_BASE: 'https://api.hh.ru',
  
  VK_TOKEN: process.env.VK_TOKEN || '',
  VK_API_BASE: 'https://api.vk.com/method',
  VK_VERSION: '5.131',
  
  PROJECTS: {
    2: { 
      name: 'Раддолье — Маркетолог', 
      queries: ['маркетолог', 'интернет маркетолог'] 
    },
    3: { 
      name: 'Кубачи — CMO', 
      queries: ['директор маркетинга', 'cmo'] 
    },
    8: { 
      name: 'TopLash — Account Recovery', 
      queries: ['account recovery specialist'] 
    },
    9: { 
      name: 'Грисфот — РОП', 
      queries: ['руководитель отдела продаж'] 
    }
  },
  
  TIMEOUT: 30000,
  DELAY_MIN: 1000,
  DELAY_MAX: 3000
};

function log(message, level = 'INFO') {
  const timestamp = new Date().toLocaleString('ru-RU');
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function delay(min = CONFIG.DELAY_MIN, max = CONFIG.DELAY_MAX) {
  const ms = Math.random() * (max - min) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initGoogleSheets() {
  try {
    const doc = new GoogleSpreadsheet(CONFIG.SPREADSHEET_ID);
    
    await doc.useServiceAccountAuth({
      client_email: CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: CONFIG.GOOGLE_PRIVATE_KEY
    });
    
    await doc.loadInfo();
    log('✅ Google Sheets подключена', 'SUCCESS');
    return doc;
  } catch (error) {
    log(`❌ Ошибка Google Sheets: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function addToGoogleSheets(doc, projectId, data) {
  try {
    const projectName = CONFIG.PROJECTS[projectId]?.name || `Project ${projectId}`;
    
    let sheet = doc.sheetsByTitle[projectName];
    if (!sheet) {
      sheet = doc.sheetsByIndex[0];
    }
    
    const row = {
      'Дата': new Date().toLocaleDateString('ru-RU'),
      'Источник': data.source || 'Unknown',
      'Ссылка': data.url || '',
      'ФИО': data.name || 'Не указано',
      'Контакт': data.contact || '',
      'Должность': data.position || 'Не указано',
      'Компания': data.company || 'Не указано',
      'Город': data.city || 'Не указано',
      'Статус': data.status || 'Подходит',
      'Краткое summary': data.summary || ''
    };
    
    await sheet.addRows([row]);
    
    log(`✅ Добавлено: ${data.name} (${data.source})`);
    return true;
  } catch (error) {
    log(`⚠️ Ошибка добавления: ${error.message}`, 'WARN');
    return false;
  }
}

async function parseHHResumes(query, projectId) {
  try {
    log(`🔍 HH.ru: "${query}"`);
    
    const url = `${CONFIG.HH_API_BASE}/resumes?text=${encodeURIComponent(query)}&per_page=50&order_by=publication_time`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: CONFIG.TIMEOUT
    });
    
    const resumes = response.data.items || [];
    const candidates = [];
    
    for (const resume of resumes) {
      const candidate = {
        url: resume.url ? `https://hh.ru${resume.url}` : '',
        name: `${resume.first_name || ''} ${resume.last_name || ''}`.trim(),
        contact: extractContact(resume),
        position: resume.title || 'Не указано',
        company: resume.employer?.name || 'Не указано',
        city: resume.area?.name || 'Не указано',
        source: 'HH.ru',
        status: 'Подходит',
        summary: resume.title || ''
      };
      
      if (candidate.name && candidate.name.length > 2) {
        candidates.push(candidate);
      }
    }
    
    log(`📊 HH.ru найдено: ${candidates.length}`);
    return candidates;
  } catch (error) {
    log(`❌ HH.ru ошибка: ${error.message}`, 'ERROR');
    return [];
  }
}

async function searchVKProfiles(query, projectId) {
  let browser;
  try {
    log(`🔍 VK: "${query}"`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    const searchUrl = `https://vk.com/search?q=${encodeURIComponent(query)}&type=people`;
    await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: CONFIG.TIMEOUT });
    
    const candidates = await page.evaluate(() => {
      const results = [];
      const elements = document.querySelectorAll('[data-peer-id]');
      
      elements.forEach((element) => {
        try {
          const peerId = element.getAttribute('data-peer-id');
          const name = element.querySelector('.mem_name')?.innerText?.trim() || '';
          
          if (name && peerId) {
            results.push({
              url: `https://vk.com/id${peerId}`,
              name: name,
              contact: `vk.com/id${peerId}`,
              position: 'Профессионал',
              company: 'VK',
              city: 'Не указано',
              source: 'VK',
              status: 'Потенциально подходит',
              summary: 'VK профиль'
            });
          }
        } catch (e) {
          console.error('Ошибка:', e.message);
        }
      });
      
      return results;
    });
    
    await browser.close();
    log(`📊 VK найдено: ${candidates.length}`);
    return candidates;
    
  } catch (error) {
    log(`⚠️ VK ошибка: ${error.message}`, 'WARN');
    if (browser) await browser.close();
    return [];
  }
}

function extractContact(resume) {
  const contacts = [];
  
  if (resume.phone) contacts.push(resume.phone);
  if (resume.email) contacts.push(resume.email);
  if (resume.contact?.phone) contacts.push(resume.contact.phone);
  if (resume.contact?.email) contacts.push(resume.contact.email);
  
  return contacts.length > 0 ? contacts.join(', ') : '';
}

async function main() {
  log('🚀 НАЧАЛО АГЕНТА X', 'INFO');
  
  let doc;
  try {
    doc = await initGoogleSheets();
  } catch (error) {
    log('⚠️ Режим тестирования (без Google Sheets)', 'WARN');
  }
  
  let totalAdded = 0;
  const addedUrls = new Set();
  
  for (const [projectId, project] of Object.entries(CONFIG.PROJECTS)) {
    log(`\n📁 ${project.name}`);
    
    for (const query of project.queries) {
      log(`  🔍 "${query}"`);
      
      const hhResumes = await parseHHResumes(query, projectId);
      for (const resume of hhResumes) {
        if (!addedUrls.has(resume.url)) {
          if (doc) await addToGoogleSheets(doc, projectId, resume);
          addedUrls.add(resume.url);
          totalAdded++;
        }
      }
      
      await delay();
      
      const vkProfiles = await searchVKProfiles(query, projectId);
      for (const profile of vkProfiles) {
        if (!addedUrls.has(profile.url)) {
          if (doc) await addToGoogleSheets(doc, projectId, profile);
          addedUrls.add(profile.url);
          totalAdded++;
        }
      }
      
      await delay();
    }
  }
  
  log(`\n✅ ГОТОВО! Добавлено: ${totalAdded}`, 'SUCCESS');
}

if (require.main === module) {
  main().catch(error => {
    log(`💥 Ошибка: ${error.message}`, 'ERROR');
    process.exit(1);
  });
}

module.exports = { parseHHResumes, searchVKProfiles, addToGoogleSheets };
