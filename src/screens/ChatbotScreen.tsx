import { useState, useEffect, useRef } from 'react';
import { processQuestion, ChatMessage, isAIAvailable } from '../utils/chatbot';

const ChatbotScreen = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const available = isAIAvailable();
    setAiAvailable(available);
    
    // Add welcome message
    const welcomeMessage: ChatMessage = {
      id: 'welcome',
      role: 'assistant',
      content: available 
        ? 'שלום! אני עוזר AI לשאלות על משחקי הפוקר שלך. שאל אותי כל שאלה - על שחקנים, משחקים, סטטיסטיקות ועוד!'
        : 'שלום! אני עוזר לשאלות על משחקי הפוקר שלך. שאל אותי כל שאלה - על שחקנים, משחקים, סטטיסטיקות ועוד! (מצב מקומי - ללא AI)',
      timestamp: new Date(),
      source: 'local',
    };
    setMessages([welcomeMessage]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsProcessing(true);

    try {
      const result = await processQuestion(userMessage.content);
      
      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.answer,
        timestamp: new Date(),
        source: result.source,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'סליחה, אירעה שגיאה. נסה שוב.',
        timestamp: new Date(),
        source: 'local',
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const suggestedQuestions = [
    'מי המוביל בטבלה?',
    'כמה משחקים שיחקתי?',
    'מה הרווח הכולל שלי?',
    'מי ניצח במשחק האחרון?',
    'מה הטבלה העליונה?',
  ];

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <h1 className="page-title">💬 עוזר AI</h1>
        <p className="page-subtitle">
          {aiAvailable ? '🤖 AI פעיל' : '📱 מצב מקומי'}
        </p>
      </div>

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}>
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                background: msg.role === 'user'
                  ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                  : 'var(--card-background)',
                color: msg.role === 'user' ? 'white' : 'var(--text)',
                border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                boxShadow: msg.role === 'user' ? '0 2px 8px rgba(59, 130, 246, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.content}
              {msg.role === 'assistant' && msg.source && (
                <div style={{
                  fontSize: '0.7rem',
                  opacity: 0.7,
                  marginTop: '0.5rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}>
                  {msg.source === 'ai' ? '🤖 AI' : '📱 מקומי'}
                </div>
              )}
            </div>
          </div>
        ))}
        
        {isProcessing && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '0.75rem 1rem',
              borderRadius: '12px',
              background: 'var(--card-background)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{ fontSize: '1.2rem' }}>💭</span>
              <span>חושב...</span>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested questions */}
      {messages.length === 1 && (
        <div style={{ padding: '0 1rem 0.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            שאלות מומלצות:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {suggestedQuestions.map((q, idx) => (
              <button
                key={idx}
                onClick={() => setInput(q)}
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '8px',
                  background: 'var(--card-background)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--primary)';
                  e.currentTarget.style.color = 'white';
                  e.currentTarget.style.borderColor = 'var(--primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--card-background)';
                  e.currentTarget.style.color = 'var(--text)';
                  e.currentTarget.style.borderColor = 'var(--border)';
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div style={{
        padding: '1rem',
        borderTop: '1px solid var(--border)',
        background: 'var(--background)',
      }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="שאל שאלה..."
            style={{
              flex: 1,
              padding: '0.75rem',
              borderRadius: '12px',
              border: '1px solid var(--border)',
              background: 'var(--card-background)',
              color: 'var(--text)',
              fontSize: '1rem',
              fontFamily: 'inherit',
              resize: 'none',
              minHeight: '44px',
              maxHeight: '120px',
            }}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '12px',
              background: input.trim() && !isProcessing
                ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                : 'var(--border)',
              color: input.trim() && !isProcessing ? 'white' : 'var(--text-muted)',
              border: 'none',
              fontSize: '1rem',
              fontWeight: '500',
              cursor: input.trim() && !isProcessing ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
            }}
          >
            שלח
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatbotScreen;

