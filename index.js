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

async function startServer() {
  app.use(cors());
  app.use(express.json());

  // Supabase setup
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "https://cmaxutqmblvvghftouqx.supabase.co";
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtYXh1dHFtYmx2dmdoZnRvdXF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU1NTkyNDksImV4cCI6MjA4MTEzNTI0OX0.a8VbYwNY6mYkCBMiSSwUVU-zThSQnvIBEeH4GT_i-Xk";
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log("✅ تم إعداد Supabase بنجاح");

  // ✅ FIXED: Groq instance function
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

  // Gemini instance function
  const getGeminiInstance = () => {
    let key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.API_KEY || process.env.GROQ_API_KEY;
    if (key) {
      key = key.trim().replace(/^["']|["']$/g, '');
    }

    if (!key || key === 'undefined' || key === 'null' || key.length < 10) {
      console.error("❌ لا يوجد مفتاح Gemini API صالح");
      return null;
    }

    console.log(`🔍 فحص مفتاح Gemini: البداية=${key.substring(0, 7)}, النهاية=${key.substring(key.length - 4)}, الطول=${key.length}`);
    return new GoogleGenerativeAI(key);
  };

  // Retry function
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

  // ✅ FIXED: /api/health
  app.get('/api/health', (req, res) => {
    const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.API_KEY;
    const cleanedGroqKey = groqKey ? groqKey.trim().replace(/^["']|["']$/g, '') : null;
    const cleanedGeminiKey = geminiKey ? geminiKey.trim().replace(/^["']|["']$/g, '') : null;

    res.json({
      status: "ok",
      message: "Server is running",
      env: {
        hasGroqKey: !!cleanedGroqKey,
        groqKeyDetails: cleanedGroqKey ? {
          length: cleanedGroqKey.length,
          prefix: cleanedGroqKey.substring(0, 7),
          suffix: cleanedGroqKey.substring(cleanedGroqKey.length - 4)
        } : "none",
        hasGeminiKey: !!cleanedGeminiKey,
        hasSupabase: !!supabaseUrl,
        nodeEnv: process.env.NODE_ENV
      }
    });
  });

  // ✅ FIXED: /api/test-ai
  app.get('/api/test-ai', async (req, res) => {
    const groq = getGroqInstance();
    if (groq) {
      try {
        const completion = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: 'Say hello' }],
          max_tokens: 50
        });
        return res.json({
          groq: completion.choices[0].message.content,
          status: 'Groq OK'
        });
      } catch (error) {
        console.error('Groq test failed:', error.message);
      }
    }

    const gemini = getGeminiInstance();
    if (!gemini) return res.status(500).json({ error: "No AI key" });

    try {
      const model = gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const response = await model.generateContent("Say hello");
      res.json({
        gemini: response.response.text(),
        status: 'Gemini OK'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ✅ FIXED MAIN ENDPOINT - BULLETPROOF Groq + Messages Fix
  app.post('/api/ai', async (req, res) => {
    console.log('📡 AI Request received:', {
      provider: req.body.provider,
      model: req.body.model,
      forceGroq: req.body.forceGroq,
      contentsType: typeof req.body.contents,
      contentsLength: req.body.contents?.length
    });

    // ✅ PRIORITY 1: Handle Groq requests (BULLETPROOF messages fix)
    if (req.body.provider === 'groq' || req.body.forceGroq) {
      const groq = getGroqInstance();
      if (!groq) {
        return res.status(400).json({
          error: "GROQ_API_KEY مفقود من ملف .env. أضف مفتاحك من console.groq.com"
        });
      }

      // ✅ BULLETPROOF: Fix messages format
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

      // ✅ Validate & clean messages
      const validMessages = messages
        .slice(-10) // Last 10 messages only
        .map(msg => ({
          role: msg.role || 'user',
          content: msg.content || String(msg)
        }))
        .filter(msg => msg.content && msg.content.trim());

      console.log(`✅ Fixed ${validMessages.length} messages for Groq`);

      const model = ['llama-3.1-8b-instant', 'llama-3.1-70b-versatile'].includes(req.body.model || '')
        ? req.body.model
        : 'llama-3.1-8b-instant';

      try {
        console.log('🚀 Using GROQ:', model);
        const completion = await groq.chat.completions.create({
          model,
          messages: validMessages,
          max_tokens: 2048,
          temperature: 0.7
        });

        console.log('✅ GROQ SUCCESS!');
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
          debug: { receivedType: typeof req.body.contents }
        });
      }
    }

    // ✅ FALLBACK: Gemini
    console.log('🤖 Using Gemini (fallback)');
    const ai = getGeminiInstance();
    if (!ai) {
      return res.status(500).json({ error: "Gemini API Key is missing on server" });
    }

    try {
      const { model, contents, config } = req.body;
      const response = await callWithRetry(() => {
        const geminiModel = ai.getGenerativeModel({ model: model || 'gemini-1.5-flash' });
        return geminiModel.generateContent(contents, config);
      });

      let text = "";
      try {
        text = response.response.text() || "";
      } catch (e) {
        console.warn("Could not read response text in /api/ai:", e);
      }

      const result = {
        text: text,
        candidates: response.response.candidates
      };
      res.json(result);
    } catch (error) {
      console.error("Gemini Generic Error:", error);
      res.status(500).json({ error: error.message || "AI request failed" });
    }
  });

  // ✅ FIXED: /api/chat endpoint
  app.post('/api/chat', async (req, res) => {
    console.log('📡 Chat Request:', req.body.provider);

    if (req.body.provider === 'groq') {
      const groq = getGroqInstance();
      if (groq) {
        try {
          // ✅ Fix messages for chat endpoint too
          let messages = [];
          if (Array.isArray(req.body.message)) {
            messages = req.body.message;
          } else if (req.body.message && typeof req.body.message === 'object') {
            messages = [req.body.message];
          } else if (typeof req.body.message === 'string') {
            messages = [{ role: 'user', content: req.body.message }];
          }

          const validMessages = messages.map(msg => ({
            role: msg.role || 'user',
            content: msg.content || String(msg)
          })).filter(msg => msg.content);

          console.log('🚀 Chat using GROQ');
          const completion = await groq.chat.completions.create({
            model: req.body.model || 'llama-3.1-8b-instant',
            messages: validMessages,
            max_tokens: 2048,
            temperature: 0.7
          });
          return res.json({
            text: completion.choices[0].message.content
          });
        } catch (error) {
          console.error('❌ Groq Chat Error:', error.message);
        }
      }
    }

    // Gemini fallback
    const ai = getGeminiInstance();
    if (!ai) {
      return res.status(500).json({
        error: "مفتاح API الخاص بـ Gemini مفقود أو غير صحيح."
      });
    }

    try {
      const { message, context, model = 'gemini-1.5-flash' } = req.body;
      const response = await callWithRetry(() => {
        const geminiModel = ai.getGenerativeModel({ model });
        return geminiModel.generateContent({
          contents: message,
          generationConfig: {
            systemInstruction: "أنت مساعد ذكي لمنصة الطالب الذكي. السياق المتاح: " + (context || "عام")
          }
        });
      });

      let text = "";
      try {
        text = response.response.text() || "";
      } catch (e) {
        console.warn("Could not read response text:", e);
        const finishReason = response.response.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY') {
          text = "عذراً، لا يمكنني الإجابة على هذا السؤال لأسباب تتعلق بسياسات السلامة.";
        } else {
          text = "عذراً، حدث خطأ أثناء معالجة الرد.";
        }
      }

      res.json({ text });
    } catch (error) {
      console.error("Gemini Server Error:", error);
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

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const PORT = process.env.PORT || 3000;
  if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 خادم المنصة يعمل على المنفذ ${PORT}`);
      console.log(`✅ Groq Ready: ${!!(process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY)}`);
      console.log(`✅ Gemini Ready: ${!!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY)}`);
    });
  }
}

startServer();
export default app;
