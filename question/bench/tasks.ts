export interface BenchTask {
  id: string
  prompt: string
  category: 'code-gen' | 'bug-fix' | 'refactor' | 'analysis'
  difficulty: 'easy' | 'medium' | 'hard'
  evaluationCriteria: string
}

export const TASKS: BenchTask[] = [
  {
    id: 'task-001',
    prompt: 'Write a function that finds the longest common subsequence of two strings. Include proper TypeScript types and a few test cases.',
    category: 'code-gen',
    difficulty: 'medium',
    evaluationCriteria: 'Correctness of LCS algorithm, TypeScript types, test coverage',
  },
  {
    id: 'task-002',
    prompt: 'This function has a bug — it should return all unique palindromic substrings but it returns duplicates and misses single characters:\n\nfunction palindromes(s: string): string[] {\n  const result: string[] = []\n  for (let i = 0; i < s.length; i++) {\n    for (let j = i + 2; j <= s.length; j++) {\n      const sub = s.slice(i, j)\n      if (sub === sub.split("").reverse().join("")) {\n        result.push(sub)\n      }\n    }\n  }\n  return [...new Set(result)]\n}\n\nFix it.',
    category: 'bug-fix',
    difficulty: 'easy',
    evaluationCriteria: 'Fixes duplicate issue, includes single character palindromes, maintains efficiency',
  },
  {
    id: 'task-003',
    prompt: 'Refactor this code to use a strategy pattern and make it extensible for new payment methods:\n\nclass PaymentProcessor {\n  processPayment(type: string, amount: number) {\n    if (type === "credit_card") {\n      console.log(`Processing credit card payment of $${amount}`)\n    } else if (type === "paypal") {\n      console.log(`Processing PayPal payment of $${amount}`)\n    } else if (type === "crypto") {\n      console.log(`Processing crypto payment of $${amount}`)\n    }\n  }\n}',
    category: 'refactor',
    difficulty: 'medium',
    evaluationCriteria: 'Clean strategy pattern, extensible, proper TypeScript types, no if-else chains',
  },
  {
    id: 'task-004',
    prompt: 'Implement a rate limiter that supports both sliding window and token bucket algorithms. It should be usable as Express middleware. Include proper error handling and TypeScript types.',
    category: 'code-gen',
    difficulty: 'hard',
    evaluationCriteria: 'Both algorithms implemented, middleware pattern, error handling, TypeScript quality',
  },
  {
    id: 'task-005',
    prompt: 'Analyze the following API endpoint for security vulnerabilities and suggest fixes:\n\napp.get("/user/:id", async (req, res) => {\n  const user = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)\n  const posts = await db.query(`SELECT * FROM posts WHERE user_id = ${req.params.id} AND status != \'draft\'`)\n  res.json({ user, posts })\n})',
    category: 'analysis',
    difficulty: 'easy',
    evaluationCriteria: 'Identifies SQL injection, identifies information leakage (draft posts query bypass), suggests parameterized queries',
  },
  {
    id: 'task-006',
    prompt: 'Write a concurrent task queue with configurable concurrency, retry logic, and progress tracking. Should support cancellation of individual tasks and the entire queue.',
    category: 'code-gen',
    difficulty: 'hard',
    evaluationCriteria: 'Concurrency control, retry with backoff, progress events, cancellation support, TypeScript quality',
  },
  {
    id: 'task-007',
    prompt: 'This async function has a race condition — sometimes it processes the same item twice:\n\nasync function processQueue(items: string[]) {\n  const seen = new Set<string>()\n  const results = await Promise.all(\n    items.map(async (item) => {\n      if (seen.has(item)) return null\n      seen.add(item)\n      return await processItem(item)\n    })\n  )\n  return results.filter(Boolean)\n}\n\nFix it and explain the race condition.',
    category: 'bug-fix',
    difficulty: 'medium',
    evaluationCriteria: 'Identifies the concurrent Set mutation race condition, fixes it properly, clear explanation',
  },
  {
    id: 'task-008',
    prompt: 'Write a memoization utility that supports custom cache keys, TTL-based expiration, and cache size limits. Should work with both sync and async functions.',
    category: 'code-gen',
    difficulty: 'medium',
    evaluationCriteria: 'Custom cache key function, TTL support, LRU eviction, async compatibility, TypeScript generic types',
  },
]
