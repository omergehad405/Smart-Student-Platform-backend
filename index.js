import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(express.json({ limit: '50mb', extended: true }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(cors());
app.use(express.json());

// Supabase setup
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "https://cmaxutqmblvvghftouqx.supabase.co";
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtYXh1dHFtYmx2dmdoZnRvdXF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU1NTkyNDksImV4cCI6MjA4MTEzNTI0OX0.a8VbYwNY6mYkCBMiSSwUVU-zThSQnvIBEeH4GT_i-Xk";
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("✅ تم إعداد Supabase بنجاح");

// ✅ UPDATED: Helper functions
const getGroqInstance = () => {
  let key = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
  if (key) key = key.trim().replace(/^["']|["']$/g, '');
  if (!key || key === 'undefined' || key === 'null' || key.length < 10) {
    console.error("❌ لا يوجد مفتاح GROQ_API_KEY صالح");
    return null;
  }
  console.log(`🔍 فحص مفتاح Groq: البداية=${key.substring(0, 7)}, النهاية=${key.substring(key.length - 4)}, الطول=${key.length}`);
  return new Groq({ apiKey: key });
};

const getGeminiInstance = () => {
  let key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.API_KEY;
  if (key) key = key.trim().replace(/^["']|["']$/g, '');
  if (!key || key === 'undefined' || key === 'null' || key.length < 10) {
    console.error("❌ لا يوجد مفتاح GEMINI_API_KEY صالح");
    return null;
  }
  console.log(`🔍 فحص مفتاح Gemini: البداية=${key.substring(0, 7)}, النهاية=${key.substring(key.length - 4)}, الطول=${key.length}`);
  return new GoogleGenerativeAI(key);
};

const callWithRetry = async (fn, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const is503 = error.message?.includes("503") || error.message?.includes("high demand");
      if (is503 && i < retries - 1) {
        console.log(`⚠️ ضغط عالي على النموذج، محاولة رقم ${i + 1} بعد ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
};

// ✅ NEW: Supported Gemini models (YOUR exact models)
const VALID_GEMINI_MODELS = [
  'gemini-3-flash-preview',           // ✅ ADD
  'gemini-2.5-flash-preview-tts',     // ✅ ADD  
  'gemini-2.5-flash-native-audio-preview-12-2025', // ✅ ADD
  'gemini-2.5-flash-preview',         // ✅ ADD
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro'
];


// ✅ NEW: Groq handler
const handleGroqRequest = async (req, res) => {
  const groq = getGroqInstance();
  if (!groq) {
    return res.status(400).json({
      error: "GROQ_API_KEY مفقود من .env (console.groq.com)",
      code: 400
    });
  }

  let messages = [];
  if (Array.isArray(req.body.contents)) {
    messages = req.body.contents;
  } else if (req.body.contents && typeof req.body.contents === 'object') {
    messages = [req.body.contents];
  } else if (typeof req.body.contents === 'string') {
    messages = [{ role: 'user', content: req.body.contents }];
  } else {
    messages = [{ role: 'user', content: 'Hello' }];
  }

  const validMessages = messages
    .slice(-10)
    .map(msg => ({
      role: msg.role || 'user',
      content: msg.content || String(msg)
    }))
    .filter(msg => msg.content && msg.content.trim());

  const groqModel = ['llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768'].includes(req.body.model)
    ? req.body.model
    : 'llama-3.1-8b-instant';

  try {
    console.log('🚀 GROQ:', groqModel);
    const completion = await groq.chat.completions.create({
      model: groqModel,
      messages: validMessages,
      max_tokens: 2048,
      temperature: 0.7
    });

    return res.json({
      choices: [{
        message: {
          content: completion.choices[0].message.content,
          role: 'assistant'
        }
      }],
      model: completion.model,
      usage: completion.usage
    });
  } catch (error) {
    console.error('❌ Groq Error:', error.message);
    return res.status(500).json({
      error: `Groq Error: ${error.message}`,
      provider: 'groq',
      code: 500
    });
  }
};

// ✅ NEW: Gemini handler (SUPPORTS YOUR MODELS)
const handleGeminiRequest = async (req, res) => {
  const ai = getGeminiInstance();
  if (!ai) {
    return res.status(500).json({
      error: "GEMINI_API_KEY مفقود من .env (ai.google.dev)",
      code: 500
    });
  }

  try {
    const { model = 'gemini-1.5-flash', contents, config = {} } = req.body;

    const safeModel = VALID_GEMINI_MODELS.includes(model) ? model : 'gemini-1.5-flash';
    console.log('🤖 GEMINI:', safeModel, 'TTS?', model.includes('tts'));

    const geminiModel = ai.getGenerativeModel({
      model: safeModel,
      generationConfig: {
        ...config,
        maxOutputTokens: 2048,
        temperature: config.temperature || 0.7
      }
    });

    let response;
    let messages = Array.isArray(contents) ? contents : [contents];

    // ✅ Special TTS handling
    if (model === 'gemini-2.5-flash-preview-tts') {
      response = await geminiModel.generateContent(messages);
      return res.json({
        text: response.response.text(),
        audio: true,
        model: safeModel,
        isTTS: true,
        candidates: response.response.candidates
      });
    }

    // Regular generation
    response = await callWithRetry(() => geminiModel.generateContent(messages));

    const text = response.response.text() || "";

    return res.json({
      text,
      model: safeModel,
      candidates: response.response.candidates,
      isTTS: model.includes('tts')
    });

  } catch (error) {
    console.error("❌ Gemini Error Details:", {
      message: error.message,
      code: error.code,
      status: error.status,
      model: req.body.model
    });

    // ✅ Clear error messages
    const errorMsg = error.message || 'Unknown Gemini error';

    return res.status(500).json({
      error: errorMsg,
      provider: 'gemini',
      model: req.body.model || 'unknown',
      code: 500,
      text: ''  // ✅ Prevent frontend JSON.parse(undefined)
    });
  }

};

// API routes

app.get('/api/health', (req, res) => {
  const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.API_KEY;
  const cleanedGroqKey = groqKey ? groqKey.trim().replace(/^["']|["']$/g, '') : null;
  const cleanedGeminiKey = geminiKey ? geminiKey.trim().replace(/^["']|["']$/g, '') : null;

  res.json({
    status: "ok",
    message: "Server is running ✅ Multi-provider AI ready",
    env: {
      hasGroqKey: !!cleanedGroqKey,
      groqKeyDetails: cleanedGroqKey ? {
        length: cleanedGroqKey.length,
        prefix: cleanedGroqKey.substring(0, 7),
        suffix: cleanedGroqKey.substring(cleanedGroqKey.length - 4),
      } : "none",
      hasGeminiKey: !!cleanedGeminiKey,
      validGeminiModels: VALID_GEMINI_MODELS,
      hasSupabase: !!supabaseUrl,
      nodeEnv: process.env.NODE_ENV,
    },
  });
});

// ✅ UPDATED: Test all models
app.get('/api/test-ai', async (req, res) => {
  const tests = [];

  // Test Groq
  const groq = getGroqInstance();
  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 50,
      });
      tests.push({ groq: completion.choices[0].message.content, status: 'OK' });
    } catch (error) {
      tests.push({ groq: `Error: ${error.message}`, status: 'FAILED' });
    }
  }

  // Test YOUR Gemini models
  const gemini = getGeminiInstance();
  if (gemini) {
    for (const testModel of ['gemini-3-flash-preview', 'gemini-2.5-flash-preview-tts']) {
      try {
        const model = gemini.getGenerativeModel({ model: testModel });
        const response = await model.generateContent("Say hello");
        tests.push({
          [`gemini-${testModel.replace(/[-.]/g, '_')}`]: response.response.text(),
          status: 'OK'
        });
      } catch (error) {
        tests.push({
          [`gemini-${testModel.replace(/[-.]/g, '_')}`]: `Error: ${error.message.slice(0, 100)}`,
          status: 'FAILED'
        });
      }
    }
  }

  res.json({ tests, status: 'All tests completed' });
});

// ✅ MAIN UPDATED /api/ai endpoint
app.post('/api/ai', async (req, res) => {
  console.log('📡 AI Request:', {
    provider: req.body.provider,
    model: req.body.model,
    forceGroq: req.body.forceGroq,
    forceProvider: req.body.forceProvider
  });

  const { provider = 'auto', model = 'llama-3.1-8b-instant', contents, config } = req.body;

  // ✅ Smart routing logic
  if (provider === 'groq' || req.body.forceGroq) {
    return handleGroqRequest(req, res);
  }

  if (provider === 'gemini' || req.body.forceProvider) {
    return handleGeminiRequest(req, res);
  }

  // Auto-detect by model
  if (VALID_GEMINI_MODELS.includes(model)) {
    console.log('🔍 Auto Gemini:', model);
    return handleGeminiRequest(req, res);
  }

  // Default Groq
  console.log('🔍 Default Groq');
  return handleGroqRequest(req, res);
});

app.post('/api/chat', async (req, res) => {
  console.log('📡 Chat Request:', req.body.provider);

  if (req.body.provider === 'groq') {
    return handleGroqRequest(req, res);
  }

  // Gemini chat
  const ai = getGeminiInstance();
  if (!ai) {
    return res.status(500).json({
      error: "مفتاح API الخاص بـ Gemini مفقود أو غير صحيح."
    });
  }

  try {
    const { message, context, model = 'gemini-1.5-flash' } = req.body;
    const safeModel = VALID_GEMINI_MODELS.includes(model) ? model : 'gemini-1.5-flash';

    const geminiModel = ai.getGenerativeModel({
      model: safeModel,
      generationConfig: {
        systemInstruction: "أنت مساعد ذكي لمنصة الطالب الذكي. السياق: " + (context || "عام")
      }
    });

    const response = await callWithRetry(() =>
      geminiModel.generateContent(Array.isArray(message) ? message : [message])
    );

    let text = response.response.text() || "عذراً، حدث خطأ.";

    res.json({ text });
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    res.status(500).json({ error: "فشل AI: " + (error.message || "Unknown error") });
  }
});

// Data endpoints (unchanged)
app.get('/api/data', async (req, res) => {
  try {
    const { data: profiles } = await supabase.from('profiles').select('*');
    const { data: subjects } = await supabase.from('subjects').select('*');
    const { data: tasks } = await supabase.from('tasks').select('*');
    const { data: notes } = await supabase.from('notes').select('*');
    res.json({ user: profiles?.[0], subjects, tasks, notes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user', async (req, res) => {
  const { id, email, full_name, xp } = req.body;
  const { error } = await supabase.from('profiles').upsert({ id, email, full_name, xp });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/subjects', async (req, res) => {
  const subjects = req.body;
  const { error } = await supabase.from('subjects').upsert(subjects);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/tasks', async (req, res) => {
  const tasks = req.body;
  const { error } = await supabase.from('tasks').upsert(tasks);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/notes', async (req, res) => {
  const notes = req.body;
  const { error } = await supabase.from('notes').upsert(notes);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/quizzes', async (req, res) => {
  const quiz = req.body;
  const { error } = await supabase.from('published_quizzes').upsert(quiz);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/quizzes/:id', async (req, res) => {
  const { data, error } = await supabase.from('published_quizzes').select('*').eq('id', req.params.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Video endpoints (unchanged)
app.post('/api/ai/videos', async (req, res) => {
  const ai = getGeminiInstance();
  if (!ai) return res.status(500).json({ error: "Gemini API Key is missing" });
  try {
    const { model, prompt, config, image } = req.body;
    const videoParams = {
      model: model || 'veo-3.1-fast-generate-preview',
      prompt: prompt,
      config: config
    };
    if (image) {
      videoParams.image = image;
    }
    const operation = await ai.getGenerativeModel(videoParams.model).generateVideos(videoParams);
    res.json(operation);
  } catch (error) {
    console.error("Video Gen Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/videos/operation', async (req, res) => {
  const ai = getGeminiInstance();
  if (!ai) return res.status(500).json({ error: "Gemini API Key is missing" });
  try {
    const { operation } = req.body;
    const result = await ai.getVideosOperation({ operation });
    res.json(result);
  } catch (error) {
    console.error("Video Op Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Vite dev middleware and static serving
(async () => {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get(/(.*)/, (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const PORT = process.env.PORT || 3000;
  if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 خادم المنصة يعمل على المنفذ ${PORT}`);
      console.log(`✅ Groq Ready: ${!!(process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY)}`);
      console.log(`✅ Gemini Ready: ${!!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY)}`);
      console.log(`✅ Gemini Models: ${VALID_GEMINI_MODELS.join(', ')}`);
    });
  }
})();

export default app;
