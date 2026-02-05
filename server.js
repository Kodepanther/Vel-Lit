import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';


dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const PORT = process.env.PORT || 3000;

// In-memory storage for prototype
let storedRole = null;
let rankedCandidates = [];
let processingProgress = { current: 0, total: 0, currentName: '', status: 'idle' };

// Helper: Extract text from PDF
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error('PDF parsing error:', error);
    return '';
  }
}

// Helper: Extract text from Word document
async function extractTextFromWord(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    console.error('Word parsing error:', error);
    return '';
  }
}

// Helper: Call Azure OpenAI API
async function callAzureOpenAI(messages, temperature = 0.7) {
  try {
    const response = await axios.post(AZURE_OPENAI_ENDPOINT, {
      messages: messages,
      temperature: temperature,
      max_tokens: 2000,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0
    }, {
      headers: {
        'api-key': AZURE_OPENAI_KEY,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Azure OpenAI API error:', error.response?.data || error.message);
    throw new Error('Failed to call Azure OpenAI API');
  }
}

// Helper: Generate AI category suggestions
async function generateCategorySuggestions(role) {
  const prompt = `
You are an expert HR consultant. Based on this job role, suggest:
1. The 5 main evaluation categories with recommended weights (must total 100%)
2. Job-specific sub-categories for evaluation

Job Title: ${role.title}
Job Description: ${role.description}

Return as JSON with this exact structure:
{
  "mainCategories": [
    { "name": "Category Name", "description": "What this measures", "weight": 20 }
  ],
  "subCategories": [
    { "name": "Sub-category", "relatedToMain": "Main Category Name", "description": "What this measures" }
  ],
  "evaluationGuidance": "Brief guidance on how to interpret scores"
}
`;

  const response = await callAzureOpenAI([
    { role: 'system', content: 'You are an expert HR consultant who creates evaluation frameworks. Always respond with valid JSON only, no markdown or extra text.' },
    { role: 'user', content: prompt }
  ]);

  return JSON.parse(response);
}

// Helper: Rank candidate
async function rankCandidate(cv_text, role, categories) {
  const prompt = `
You are an expert HR analyst evaluating a candidate against a specific role.

ROLE: ${role.title}
ROLE DESCRIPTION: ${role.description}

EVALUATION CATEGORIES:
${categories.mainCategories.map(c => `- ${c.name} (${c.weight}% weight): ${c.description}`).join('\n')}

SUB-CATEGORIES:
${categories.subCategories.map(s => `- ${s.name} (${s.relatedToMain}): ${s.description}`).join('\n')}

CANDIDATE CV:
${cv_text}

Provide a detailed evaluation in this exact JSON format:
{
  "overallScore": <0-100>,
  "mainCategoryScores": {
    "categoryName": <0-100 score>
  },
  "subCategoryScores": {
    "subCategoryName": <0-100 score>
  },
  "summary": "Blunt, direct assessment of candidate fit. Be balanced but honest. Don't compensate for weak CVs with positive comments. 3-5 sentences.",
  "redFlags": ["flag1", "flag2"],
  "interviewQuestions": [
    "question1",
    "question2",
    "question3",
    "question4",
    "question5",
    "question6",
    "question7",
    "question8",
    "question9",
    "question10"
  ],
  "aiFeedback": "AI's thoughts about this candidate and their ranking, 2-3 sentences. Be direct and analytical."
}
`;

  const response = await callAzureOpenAI([
    { role: 'system', content: 'You are an expert HR analyst. Evaluate candidates fairly but honestly. Don\'t praise weak CVs. Always respond with valid JSON only, no markdown formatting, no code blocks, just pure JSON.' },
    { role: 'user', content: prompt }
  ], 0.5);

  try {
    // Strip markdown code blocks if present
    let cleanResponse = response;
    if (cleanResponse.includes('```json')) {
      cleanResponse = cleanResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanResponse.includes('```')) {
      cleanResponse = cleanResponse.replace(/```\n?/g, '');
    }
    
    // Trim whitespace
    cleanResponse = cleanResponse.trim();
    
    console.log(`  📝 Parsed JSON successfully`);
    return JSON.parse(cleanResponse);
  } catch (error) {
    console.error('Failed to parse AI response:', response);
    throw new Error('Invalid AI response format');
  }
}
// API: Save role and get category suggestions
app.post('/api/save-role', async (req, res) => {
  try {
    const { title, description, requiredSkills } = req.body;
    
    // Generate AI suggestions
    const suggestions = await generateCategorySuggestions({
      title,
      description,
      requiredSkills
    });

    storedRole = {
      id: 'role_' + Date.now(),
      title,
      description,
      requiredSkills,
      categories: suggestions,
      createdAt: new Date()
    };

    res.json({
      success: true,
      role: storedRole,
      suggestions: suggestions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Confirm role with categories
app.post('/api/confirm-role', async (req, res) => {
  try {
    const { mainCategories, subCategories } = req.body;
    
    if (!storedRole) {
      return res.status(400).json({ error: 'No role created yet' });
    }

    storedRole.categories = {
      mainCategories,
      subCategories,
      evaluationGuidance: 'Categories confirmed by HR team'
    };

    res.json({
      success: true,
      role: storedRole
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/process-cvs', upload.array('files'), async (req, res) => {
  try {
    console.log('📥 CV Upload received');
    console.log('Files:', req.files ? req.files.length : 0);
    
    if (!storedRole) {
      console.log('❌ No role created yet');
      return res.status(400).json({ error: 'No role created yet' });
    }

    if (!req.files || req.files.length === 0) {
      console.log('❌ No files uploaded');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files;
    console.log(`📋 Processing ${files.length} files...`);
    processingProgress = { current: 0, total: files.length, currentName: '', status: 'processing' };
    rankedCandidates = [];

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      processingProgress.current = i + 1;
      processingProgress.currentName = file.originalname;
      console.log(`\n📄 Processing file ${i + 1}/${files.length}: ${file.originalname}`);

      let text = '';
      
      // Extract text based on file type
      if (file.mimetype === 'application/pdf') {
        console.log('  🔍 Extracting PDF...');
        text = await extractTextFromPDF(file.buffer);
      } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        console.log('  🔍 Extracting Word document...');
        text = await extractTextFromWord(file.buffer);
      } else {
        console.log('  🔍 Reading as text...');
        text = file.buffer.toString('utf-8');
      }

      console.log(`  ✅ Text extracted: ${text.length} characters`);

      if (!text || text.trim().length < 50) {
        console.log(`  ⚠️ Skipping: insufficient text (${text.length} chars)`);
        continue;
      }

      // Rank candidate
      try {
        console.log(`  🤖 Calling Azure OpenAI to rank candidate...`);
        const ranking = await rankCandidate(text, storedRole, storedRole.categories);
        console.log(`  ✅ Score: ${ranking.overallScore}/100`);
        
        rankedCandidates.push({
          id: 'cand_' + Date.now() + '_' + i,
          filename: file.originalname,
          cvText: text.substring(0, 500),
          ranking: ranking,
          reviewed: false,
          interviewNotes: '',
          recalibratedScore: null
        });
      } catch (error) {
        console.error(`  ❌ Error ranking ${file.originalname}:`, error.message);
      }

      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Sort by overall score
    rankedCandidates.sort((a, b) => b.ranking.overallScore - a.ranking.overallScore);

    processingProgress.status = 'complete';
    console.log(`\n✅ Processing complete! ${rankedCandidates.length} candidates ranked.`);

    res.json({
      success: true,
      candidatesCount: rankedCandidates.length,
      candidates: rankedCandidates.map(c => ({
        id: c.id,
        filename: c.filename,
        overallScore: c.ranking.overallScore,
        reviewed: c.reviewed
      }))
    });
  } catch (error) {
    console.error('❌ Error processing CVs:', error.message);
    console.error(error);
    processingProgress.status = 'error';
    res.status(500).json({ error: error.message });
  }
});

// API: Get processing progress
app.get('/api/progress', (req, res) => {
  res.json(processingProgress);
});

// API: Get ranked candidates
app.get('/api/candidates', (req, res) => {
  const candidates = rankedCandidates.map(c => ({
    id: c.id,
    filename: c.filename,
    overallScore: c.ranking.overallScore,
    mainScores: c.ranking.mainCategoryScores,
    subScores: c.ranking.subCategoryScores,
    reviewed: c.reviewed
  }));

  res.json({
    success: true,
    candidates: candidates,
    total: candidates.length
  });
});

// API: Get candidate detail
app.get('/api/candidate/:id', (req, res) => {
  const candidate = rankedCandidates.find(c => c.id === req.params.id);
  
  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found' });
  }

  res.json({
    success: true,
    candidate: {
      id: candidate.id,
      filename: candidate.filename,
      overallScore: candidate.ranking.overallScore,
      mainScores: candidate.ranking.mainCategoryScores,
      subScores: candidate.ranking.subCategoryScores,
      summary: candidate.ranking.summary,
      redFlags: candidate.ranking.redFlags,
      interviewQuestions: candidate.ranking.interviewQuestions,
      aiFeedback: candidate.ranking.aiFeedback,
      reviewed: candidate.reviewed,
      interviewNotes: candidate.interviewNotes,
      recalibratedScore: candidate.recalibratedScore
    }
  });
});

// API: Mark candidate as reviewed
app.post('/api/candidate/:id/review', (req, res) => {
  const candidate = rankedCandidates.find(c => c.id === req.params.id);
  
  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found' });
  }

  candidate.reviewed = true;
  res.json({ success: true });
});

// API: Ingest interview notes
app.post('/api/candidate/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    const candidate = rankedCandidates.find(c => c.id === req.params.id);
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    candidate.interviewNotes = notes;

    // Recalibrate score based on interview notes
    const recalibratePrompt = `
You are an expert HR analyst reviewing interview feedback.

ORIGINAL EVALUATION:
Overall Score: ${candidate.ranking.overallScore}/100
Summary: ${candidate.ranking.summary}

INTERVIEW NOTES:
${notes}

Based on these interview notes, provide a recalibrated assessment:
{
  "recalibratedScore": <0-100>,
  "scoreAdjustment": <-20 to +20>,
  "adjustmentReason": "Brief explanation of why score changed",
  "overallAssessment": "Updated holistic assessment 2-3 sentences"
}
`;

    const response = await callAzureOpenAI([
      { role: 'system', content: 'You are an expert HR analyst. Provide fair but honest assessment. Always respond with valid JSON only.' },
      { role: 'user', content: recalibratePrompt }
    ], 0.5);

    const recalibration = JSON.parse(response);
    candidate.recalibratedScore = recalibration;

    res.json({
      success: true,
      recalibration: recalibration
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Export results
app.get('/api/export/:format', (req, res) => {
  const format = req.params.format;

  if (format === 'csv') {
    let csv = 'Filename,Overall Score,Reviewed,Interview Notes\n';
    rankedCandidates.forEach(c => {
      csv += `"${c.filename}",${c.ranking.overallScore},${c.reviewed ? 'Yes' : 'No'},"${(c.interviewNotes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=candidates-ranking.csv');
    res.send(csv);
  } else if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=candidates-ranking.json');
    res.json({
      role: storedRole,
      candidates: rankedCandidates
    });
  } else {
    res.status(400).json({ error: 'Invalid format' });
  }
});

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`\n✅ HR AI Recruiting Prototype Server Running!`);
  console.log(`\n📱 Open your browser: http://localhost:${PORT}`);
  console.log(`\n🔑 Using Azure OpenAI Endpoint: ${AZURE_OPENAI_ENDPOINT.substring(0, 60)}...`);
});