export interface Example {
  name: string;
  source: string;
}

export const examples: Example[] = [
  {
    name: 'Student journey',
    source: `flowchart LR
  A[Applies] --> B{Fits the cohort?}
  B -->|yes| C[Onboarding call]
  B -->|no| D[Prep course]
  D --> B
  C --> E[Week 1-16 bootcamp]
  E --> F[Final project]
  F --> G([Job placement])`,
  },
  {
    name: 'Request pipeline',
    source: `flowchart TD
  U[Learner] --> CDN[Cloudflare edge]
  CDN --> W[Worker]
  W --> KV[(Session KV)]
  W --> API[Platform API]
  API --> DB[(Postgres)]
  API --> Q[[Job queue]]
  Q --> N[Notifications]`,
  },
  {
    name: 'Support handoff',
    source: `sequenceDiagram
  participant S as Student
  participant B as Support bot
  participant M as Mentor
  S->>B: I am stuck on the exercise
  B->>B: Search the syllabus
  B-->>S: Here is the relevant lesson
  S->>B: Still stuck
  B->>M: Escalate with context
  M-->>S: Pairing session booked`,
  },
  {
    name: 'Cohort states',
    source: `stateDiagram-v2
  [*] --> Enrolling
  Enrolling --> Running: cohort full
  Running --> Paused: holiday
  Paused --> Running
  Running --> Graduated: final project shipped
  Graduated --> [*]`,
  },
  {
    name: 'Subgraphs',
    source: `flowchart TB
  subgraph Client
    A[Browser] --> B[Service worker]
  end
  subgraph Edge
    C[Worker] --> D[(Cache)]
  end
  subgraph Origin
    E[API] --> F[(Database)]
  end
  B --> C
  C --> E`,
  },
];
