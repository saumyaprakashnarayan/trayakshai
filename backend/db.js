const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const connectionString = process.env.DATABASE_URL;

let pool = null;

if (connectionString) {
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected idle PostgreSQL client error:', err.message);
  });
} else {
  console.warn('⚠️ DATABASE_URL is not set. Database operations will use in-memory fallback until configured on Render.');
}

let dbInitialized = false;
let dbInitError = null;

// Initialize tables if connected
async function initDb() {
  if (!pool) {
    dbInitialized = true;
    return true;
  }
  try {
    const client = await pool.connect();
    try {
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await client.query(schemaSql);
      console.log('✅ PostgreSQL schema and seed data verified successfully.');
      dbInitialized = true;
      dbInitError = null;
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Failed to initialize PostgreSQL schema:', err.message);
    dbInitialized = false;
    dbInitError = err.message;
    return false;
  }
}

// In-memory fallback for local development when DB is not yet connected
const inMemoryStore = {
  users: new Map(),
  orders: new Map(),
  enrollments: new Map(),
  modules: new Map(),
  auditLogs: [],
  adminSettings: new Map(),
  emailVerifications: new Map()
};

// Seed in-memory modules
const seedModules = [
  {
    id: 'mod_1',
    course_id: 'ai-infrastructure-factory',
    track_number: 1,
    track_title: 'Track 01: AI Factory Architecture & Design',
    lesson_title: 'Masterclass: Sizing 80kW High-Density Liquid Cooling Loops & CDUs',
    lesson_type: 'Video Lecture',
    duration: '78 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/8yU91E1V_xM?autoplay=1',
    attachment: 'TrayakshAI_Liquid_Cooling_Sizing_Blueprint_v2.pdf',
    description: 'Direct-to-chip secondary loop thermal modeling, manifold balancing, and PUE calculators.',
    sort_order: 1
  },
  {
    id: 'mod_2',
    course_id: 'ai-infrastructure-factory',
    track_number: 2,
    track_title: 'Track 02: NVIDIA DGX/HGX Infrastructure',
    lesson_title: 'Hands-on: NVSwitch 900GB/s Fabric Telemetry & BMC Redfish Automation',
    lesson_type: 'Live Lab Recording',
    duration: '95 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/1k4N6X8XW9o?autoplay=1',
    attachment: 'DGX_H100_Redfish_Automation_Scripts.zip',
    description: 'Baseboard BMC monitoring, thermal threshold alarms, and automated PXE provisioning.',
    sort_order: 2
  },
  {
    id: 'mod_3',
    course_id: 'ai-infrastructure-factory',
    track_number: 3,
    track_title: 'Track 03: GPU Computing: H100, H200 & B200',
    lesson_title: 'Hopper vs Blackwell Microarchitectures: FP8 & FP4 Transformer Engine Tuning',
    lesson_type: 'Video Lecture',
    duration: '65 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/kYj_fBwYg3I?autoplay=1',
    attachment: 'FP8_Microscaling_TransformerEngine_Guide.pdf',
    description: 'Deep-dive into 5th Gen Tensor Cores and HBM3e bandwidth saturation techniques.',
    sort_order: 3
  },
  {
    id: 'mod_4',
    course_id: 'ai-infrastructure-factory',
    track_number: 4,
    track_title: 'Track 04: AI Networking: InfiniBand, RoCE & RDMA',
    lesson_title: 'Non-Blocking Fat-Tree Rail-Optimized Topologies & NCCL All-Reduce Tuning',
    lesson_type: 'Cluster Runbook & Scripts',
    duration: '110 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/sY8x0Y1M8v8?autoplay=1',
    attachment: 'Quantum2_InfiniBand_Rail_Optimized_Topology.yaml',
    description: 'Lossless RoCE v2 buffer tuning, PFC/ECN thresholds, and OpenSM routing.',
    sort_order: 4
  },
  {
    id: 'mod_5',
    course_id: 'ai-infrastructure-factory',
    track_number: 5,
    track_title: 'Track 05: AI Storage & High-Performance Computing',
    lesson_title: 'Parallel File Systems: Sizing 120GB/s WEKA GDS & GPFS over RoCE v2',
    lesson_type: 'Cluster Runbook & Scripts',
    duration: '90 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/8yU91E1V_xM?autoplay=1',
    attachment: 'WEKA_GPUDirect_Storage_GDS_RoCE_Benchmark.md',
    description: 'Direct NVMe-to-GPU DMA architecture bypassing CPU bounce buffers. High-IOPS checkpointing architectures for 70B+ LLM training loops, multi-tier flash caching, and InfiniBand fabric binding.',
    sort_order: 5
  },
  {
    id: 'mod_6',
    course_id: 'ai-infrastructure-factory',
    track_number: 6,
    track_title: 'Track 06: Kubernetes, Slurm & GPU Orchestration',
    lesson_title: 'Deploying the NVIDIA GPU Operator & Multi-Tenant Slurm Partitions',
    lesson_type: 'Cluster Runbook & Scripts',
    duration: '85 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/K8v0N4y9V4k?autoplay=1',
    attachment: 'k8s_gpu_operator_slurm_manifests.md',
    description: 'Production Slurm fair-share config, gang scheduling with Kueue, Container Device Interface (CDI), and multi-instance GPU slicing.',
    sort_order: 6
  },
  {
    id: 'mod_7',
    course_id: 'ai-infrastructure-factory',
    track_number: 7,
    track_title: 'Track 07: Generative AI Infrastructure & LLM Deployment',
    lesson_title: 'Megatron-LM 3D Parallelism & High-Throughput vLLM Inference Ops',
    lesson_type: 'Live Lab Recording',
    duration: '105 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/kYj_fBwYg3I?autoplay=1',
    attachment: 'Megatron_3D_Parallelism_vLLM_Deployment.md',
    description: 'Hands-on distributed tensor (TP), pipeline (PP), sequence (SP), and ZeRO-3 data parallelism across multi-node H100 clusters. PagedAttention tuning and continuous batching in production.',
    sort_order: 7
  },
  {
    id: 'mod_8',
    course_id: 'ai-infrastructure-factory',
    track_number: 8,
    track_title: 'Track 08: AI Infrastructure Migration & Optimisation',
    lesson_title: 'Cloud Repatriation: DCGM Profiling & Datacenter TCO Optimization',
    lesson_type: 'Architecture Blueprint',
    duration: '80 mins',
    video_url: 'https://www.youtube-nocookie.com/embed/1k4N6X8XW9o?autoplay=1',
    attachment: 'AI_Cloud_Repatriation_DCGM_TCO_Blueprint.md',
    description: 'Financial and hardware migration models from hyperscalers to bare-metal co-location. NVIDIA DCGM GPU idle profiling, power capping curves, and high-availability cutover runbooks.',
    sort_order: 8
  }
];

seedModules.forEach(m => inMemoryStore.modules.set(m.id, m));

module.exports = {
  pool,
  query: (text, params) => {
    if (!pool) {
      throw new Error('Database not connected: pool is null. Configure DATABASE_URL on Render.');
    }
    return pool.query(text, params);
  },
  initDb,
  inMemoryStore,
  hasDb: () => Boolean(pool),
  isReady: () => (!pool || dbInitialized),
  getInitError: () => dbInitError
};
