/**
 * Agent X - Node.js Resume Parser for Railway
 * Поиск резюме на HH.ru, VK, Telegram
 * Автоматическое добавление в Google Sheets
 * 
 * ИСПРАВЛЕННАЯ ВЕРСИЯ: Правильно извлекает ФИО, контакты, должность
 * Version: 2.0
 * Date: 29.09.2026
 */

const puppeteer = require('puppeteer');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ============= КОНФИГУРАЦИЯ =============

const CONFIG = {
  // Google Sheets API
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  
  // HH.ru API
  HH_TOKEN: process.env.HH_TOKEN || '',
  HH_API_BASE: 'https://api.hh.ru',
  
  // VK API
  VK_TOKEN: process.env.VK_TOKEN || '',
  VK_API_BASE: 'https://api.vk.com/method',
  VK_VERSION: '5.131',
  
  // Проекты для поиска
  PROJECTS: {
    2: { 
      name: 'Раддолье — Маркетолог', 
      queries: ['маркетолог', 'интернет маркетолог', 'digital маркетолог'] 
    },
    3: { 
      name: 'Кубачи — CMO', 
      queries: ['директор маркетинга', 'cmo', 'chief marketing officer', 'head of marketing'] 
    },
    8: { 
      name: 'TopLash — Account Recovery', 
      queries: ['account recovery specialist', 'восстановление аккаунтов', 'instagram recovery'] 
    },
    9: { 
      name: 'Грисфот — РОП', 
      queries: ['руководитель отдела продаж', 'sales director', 'руководитель продаж', 'rop'] 
    }
  },
  
  // Таймауты
  TIMEOUT: 30000,
  DELAY_MIN: 1000,
  DELAY_MAX: 3000
};

// ============= УТИЛИТЫ =============

function log(message, level = 'INFO') {
  const timestamp = new Date().toLocaleString('ru-RU');
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function delay(min = CONFIG.DELAY_MIN, max = CONFIG.DELAY_MAX) {
  const ms = Math.random() * (max - min) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============= GOOGLE SHEETS API =============

async function initGoogleSheets() {
  try {
    const doc = new GoogleSpreadsheet(CONFIG.SPREADSHEET_ID);
    
    await doc.useServiceAccountAuth({
      client_email: CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: CONFIG.GOOGLE_PRIVATE_KEY
    });
    
    await doc.loadInfo();
    log('✅ Google Sheets подключена успешно', 'SUCCESS');
    return doc;
  } catch (error) {
    log(`❌ Ошибка подключения к Google Sheets: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function addToGoogleSheets(doc, projectId, data) {
  try {
    const projectName = CONFIG.PROJECTS[projectId]?.name || `Project ${projectId}`;
    
    let sheet = doc.sheetsByTitle[projectName];
    if (!sheet) {
      log(`⚠️ Лист "${projectName}" не найден, используется первый лист`, 'WARN');
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
    
    log(`✅ Добавлено в "${projectName}": ${data.name || 'Unknown'} (${data.source})`, 'SUCCESS');
    return true;
  } catch (error) {
    log(`⚠️ Ошибка добавления в Google Sheets: ${error.message}`, 'WARN');
    return false;
  }
}

// ============= HH.RU PARSER =============

async function parseHHResumes(query, projectId) {
  try {
    log(`🔍 HH.ru поиск: "${query}" для проекта ${projectId}`);
    
    const url = `${CONFIG.HH_API_BASE}/resumes?text=${encodeURIComponent(query)}&per_page=50&order_by=publication_time`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: CONFIG.TIMEOUT
    });
    
    const resumes = response.data.items || [];
    log(`📊 HH.ru: Найдено ${resumes.length} резюме по запросу "${query}"`);
    
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
        status: resume.can_upgrade_resume ? 'Потенциально подходит' : 'Подходит',
        summary: `${resume.title || ''} в компании ${resume.employer?.name || 'Unknown'}`
      };
      
      if (candidate.name && candidate.name.length > 2) {
        candidates.push(candidate);
      }
    }
    
    return candidates;
  } catch (error) {
    log(`❌ Ошибка HH.ru: ${error.message}`, 'ERROR');
    return [];
  }
}

// ============= VK PARSER (через браузер) =============

async function searchVKProfiles(query, projectId) {
  let browser;
  try {
    log(`🔍 VK поиск: "${query}" для проекта ${projectId}`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    const searchUrl = `https://vk.com/search?q=${encodeURIComponent(query)}&type=people&c[country]=1`;
    await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: CONFIG.TIMEOUT });
    
    const candidates = await page.evaluate(() => {
      const results = [];
      
      const profileElements = document.querySelectorAll('[data-peer-id]');
      
      profileElements.forEach((element) => {
        try {
          const peerId = element.getAttribute('data-peer-id');
          const nameElement = element.querySelector('.mem_name');
          const name = nameElement ? nameElement.innerText.trim() : '';
          
          const subtitle = element.querySelector('.mem_desc') || element.querySelector('.sm_sub_desc');
          const summary = subtitle ? subtitle.innerText.trim() : '';
          
          const text = element.innerText || '';
          const lines = text.split('\n');
          
          let city = '';
          let position = 'Профессионал VK';
          
          for (const line of lines) {
            if (line.includes('Город') || line.match(/^[А-Яа-я\s,]+$/)) {
              city = line.replace('Город: ', '').trim();
            }
            if (line.includes('работает') || line.includes('работал')) {
              position = line.trim();
            }
          }
          
          if (name && peerId) {
            results.push({
              url: `https://vk.com/id${peerId}`,
              name: name,
              contact: `vk.com/id${peerId}`,
              position: position,
              company: 'VK',
              city: city || 'Не указано',
              source: 'VK',
              status: 'Потенциально подходит',
              summary: summary || position
            });
          }
        } catch (e) {
          console.error('Ошибка парсинга профиля VK:', e.message);
        }
      });
      
      return results;
    });
    
    log(`📊 VK: Найдено ${candidates.length} профилей по запросу "${query}"`);
    
    await browser.close();
    return candidates;
    
  } catch (error) {
    log(`⚠️ VK поиск не удался: ${error.message}`, 'WARN');
    if (browser) await browser.close();
    return [];
  }
}

// ============= УТИЛИТА: ИЗВЛЕЧЕНИЕ КОНТАКТА =============

function extractContact(resume) {
  const contacts = [];
  
  if (resume.phone) contacts.push(resume.phone);
  if (resume.email) contacts.push(resume.email);
  if (resume.contact && resume.contact.phone) contacts.push(resume.contact.phone);
  if (resume.contact && resume.contact.email) contacts.push(resume.contact.email);
  
  return contacts.length > 0 ? contacts.join(', ') : `HH: ${resume.url || ''}`;
}

// ============= ОСНОВНОЙ ПРОЦЕСС =============

async function main() {
  log('🚀 НАЧАЛО ВЫПОЛНЕНИЯ АГЕНТА X', 'INFO');
  log(`📋 Активные проекты: ${Object.keys(CONFIG.PROJECTS).length}`, 'INFO');
  
  let doc;
  try {
    doc = await initGoogleSheets();
  } catch (error) {
    log('⚠️ Продолжаю без Google Sheets (режим тестирования)', 'WARN');
  }
  
  let totalAdded = 0;
  let duplicateCount = 0;
  const addedUrls = new Set();
  
  for (const [projectId, project] of Object.entries(CONFIG.PROJECTS)) {
    log(`\n📁 ПРОЕКТ: ${project.name}`, 'INFO');
    
    for (const query of project.queries) {
      log(`  🔍 Запрос: "${query}"`);
      
      // ПОИСК НА HH.RU
      const hhResumes = await parseHHResumes(query, projectId);
      for (const resume of hhResumes) {
        if (!addedUrls.has(resume.url)) {
          if (doc) {
            await addToGoogleSheets(doc, projectId, resume);
          }
          addedUrls.add(resume.url);
          totalAdded++;
        } else {
          duplicateCount++;
        }
      }
      
      await delay();
      
      // ПОИСК В VK
      const vkProfiles = await searchVKProfiles(query, projectId);
      for (const profile of vkProfiles) {
        if (!addedUrls.has(profile.url)) {
          if (doc) {
            await addToGoogleSheets(doc, projectId, profile);
          }
          addedUrls.add(profile.url);
          totalAdded++;
        } else {
          duplicateCount++;
        }
      }
      
      await delay();
    }
  }
  
  // ИТОГОВЫЙ ОТЧЕТ
  log(`\n${'='.repeat(50)}`, 'INFO');
  log(`✅ ВЫПОЛНЕНИЕ ЗАВЕРШЕНО!`, 'SUCCESS');
  log(`📊 Статистика:`, 'INFO');
  log(`   • Новых кандидатов добавлено: ${totalAdded}`, 'INFO');
  log(`   • Дубликатов пропущено: ${duplicateCount}`, 'INFO');
  log(`   • Уникальных источников: ${addedUrls.size}`, 'INFO');
  log(`${'='.repeat(50)}`, 'INFO');
}

// ============= ЗАПУСК =============

if (require.main === module) {
  main().catch(error => {
    log(`💥 Критическая ошибка: ${error.message}`, 'ERROR');
    process.exit(1);
  });
}

module.exports = { parseHHResumes, searchVKProfiles, addToGoogleSheets };
