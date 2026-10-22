-- ============================================================================
-- TrayakshAI Course Platform Production PostgreSQL Schema
-- Database Target: Render Managed PostgreSQL
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    role VARCHAR(50) DEFAULT 'candidate', -- 'candidate', 'instructor', 'admin'
    company VARCHAR(255),
    gstin VARCHAR(50),
    google_id VARCHAR(255) UNIQUE,
    avatar_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. COURSES TABLE
CREATE TABLE IF NOT EXISTS courses (
    id VARCHAR(100) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    registration_fee INTEGER NOT NULL DEFAULT 999900, -- in paise (₹9,999)
    course_fee INTEGER NOT NULL DEFAULT 4999900,       -- in paise (₹49,999)
    cohort_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    registrations_open BOOLEAN NOT NULL DEFAULT TRUE,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. ORDERS TABLE
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    razorpay_order_id VARCHAR(100) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    course_id VARCHAR(100) NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    plan_type VARCHAR(50) NOT NULL, -- 'registration' or 'course_fee'
    amount INTEGER NOT NULL,        -- Amount in paise
    currency VARCHAR(10) DEFAULT 'INR',
    status VARCHAR(50) DEFAULT 'created', -- 'created', 'paid', 'failed'
    razorpay_payment_id VARCHAR(100) UNIQUE,
    razorpay_signature VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. ENROLLMENTS TABLE
CREATE TABLE IF NOT EXISTS enrollments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_number VARCHAR(50) UNIQUE NOT NULL, -- e.g. TR-AI-2026-981240
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id VARCHAR(100) NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id),
    plan_enrolled VARCHAR(50) NOT NULL DEFAULT 'registration',
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'suspended', 'completed'
    unlocked_content BOOLEAN DEFAULT TRUE,
    cluster_ssh_granted BOOLEAN DEFAULT FALSE,
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_course UNIQUE(user_id, course_id)
);

-- 5. MODULES & LESSONS TABLE
CREATE TABLE IF NOT EXISTS modules (
    id VARCHAR(100) PRIMARY KEY,
    course_id VARCHAR(100) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    track_number INTEGER NOT NULL,
    track_title VARCHAR(255) NOT NULL,
    lesson_title VARCHAR(255) NOT NULL,
    lesson_type VARCHAR(100) NOT NULL, -- 'Video Lecture', 'Live Lab Recording', 'Cluster Runbook'
    duration VARCHAR(50) NOT NULL,
    video_url TEXT NOT NULL,
    attachment VARCHAR(255) NOT NULL,
    attachment_content TEXT,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ensure columns exist if table was already created
ALTER TABLE modules ADD COLUMN IF NOT EXISTS attachment_content TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS max_seats INTEGER NOT NULL DEFAULT 25;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS registrations_open BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE courses ALTER COLUMN max_seats SET DEFAULT 25;

-- 6. AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event VARCHAR(255) NOT NULL,
    user_email VARCHAR(255) NOT NULL,
    ip_address VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. PERSISTENT ADMIN SETTINGS & CONFIG TABLE
CREATE TABLE IF NOT EXISTS admin_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. EMAIL VERIFICATIONS & ACCOUNT CLAIM TOKENS
CREATE TABLE IF NOT EXISTS email_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    code VARCHAR(10) NOT NULL,
    purpose VARCHAR(50) NOT NULL DEFAULT 'claim_account', -- 'claim_account', 'reset_password'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_rzp_order_id ON orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_user_id ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_modules_course_id ON modules(course_id);
CREATE INDEX IF NOT EXISTS idx_email_verif_email ON email_verifications(email);

-- SEED DEFAULT COURSE
INSERT INTO courses (id, title, registration_fee, course_fee, cohort_deadline)
VALUES (
    'ai-infrastructure-factory',
    'AI Infrastructure & AI Factory Training',
    999900,
    4999900,
    '2026-11-01 23:59:59+05:30'
) ON CONFLICT (id) DO NOTHING;

-- SEED PRODUCTION CURRICULUM MODULES
INSERT INTO modules (id, course_id, track_number, track_title, lesson_title, lesson_type, duration, video_url, attachment, description, sort_order)
VALUES 
(
    'mod_1',
    'ai-infrastructure-factory',
    1,
    'Track 01: AI Factory Architecture & Design',
    'Masterclass: Sizing 80kW High-Density Liquid Cooling Loops & CDUs',
    'Video Lecture',
    '78 mins',
    'https://www.youtube-nocookie.com/embed/8yU91E1V_xM?autoplay=1',
    'TrayakshAI_Liquid_Cooling_Sizing_Blueprint_v2.pdf',
    'Direct-to-chip secondary loop thermal modeling, manifold balancing, and PUE calculators.',
    1
),
(
    'mod_2',
    'ai-infrastructure-factory',
    2,
    'Track 02: NVIDIA DGX/HGX Infrastructure',
    'Hands-on: NVSwitch 900GB/s Fabric Telemetry & BMC Redfish Automation',
    'Live Lab Recording',
    '95 mins',
    'https://www.youtube-nocookie.com/embed/1k4N6X8XW9o?autoplay=1',
    'DGX_H100_Redfish_Automation_Scripts.zip',
    'Baseboard BMC monitoring, thermal threshold alarms, and automated PXE provisioning.',
    2
),
(
    'mod_3',
    'ai-infrastructure-factory',
    3,
    'Track 03: GPU Computing: H100, H200 & B200',
    'Hopper vs Blackwell Microarchitectures: FP8 & FP4 Transformer Engine Tuning',
    'Video Lecture',
    '65 mins',
    'https://www.youtube-nocookie.com/embed/kYj_fBwYg3I?autoplay=1',
    'FP8_Microscaling_TransformerEngine_Guide.pdf',
    'Deep-dive into 5th Gen Tensor Cores and HBM3e bandwidth saturation techniques.',
    3
),
(
    'mod_4',
    'ai-infrastructure-factory',
    4,
    'Track 04: AI Networking: InfiniBand, RoCE & RDMA',
    'Non-Blocking Fat-Tree Rail-Optimized Topologies & NCCL All-Reduce Tuning',
    'Cluster Runbook & Scripts',
    '110 mins',
    'https://www.youtube-nocookie.com/embed/sY8x0Y1M8v8?autoplay=1',
    'Quantum2_InfiniBand_Rail_Optimized_Topology.yaml',
    'Lossless RoCE v2 buffer tuning, PFC/ECN thresholds, and OpenSM routing.',
    4
),
(
    'mod_5',
    'ai-infrastructure-factory',
    5,
    'Track 05: AI Storage & High-Performance Computing',
    'Parallel File Systems: Sizing 120GB/s WEKA GDS & GPFS over RoCE v2',
    'Cluster Runbook & Scripts',
    '90 mins',
    'https://www.youtube-nocookie.com/embed/8yU91E1V_xM?autoplay=1',
    'WEKA_GPUDirect_Storage_GDS_RoCE_Benchmark.md',
    'Direct NVMe-to-GPU DMA architecture bypassing CPU bounce buffers. High-IOPS checkpointing architectures for 70B+ LLM training loops, multi-tier flash caching, and InfiniBand fabric binding.',
    5
),
(
    'mod_6',
    'ai-infrastructure-factory',
    6,
    'Track 06: Kubernetes, Slurm & GPU Orchestration',
    'Deploying the NVIDIA GPU Operator & Multi-Tenant Slurm Partitions',
    'Cluster Runbook & Scripts',
    '85 mins',
    'https://www.youtube-nocookie.com/embed/K8v0N4y9V4k?autoplay=1',
    'k8s_gpu_operator_slurm_manifests.md',
    'Production Slurm fair-share config, gang scheduling with Kueue, Container Device Interface (CDI), and multi-instance GPU slicing.',
    6
),
(
    'mod_7',
    'ai-infrastructure-factory',
    7,
    'Track 07: Generative AI Infrastructure & LLM Deployment',
    'Megatron-LM 3D Parallelism & High-Throughput vLLM Inference Ops',
    'Live Lab Recording',
    '105 mins',
    'https://www.youtube-nocookie.com/embed/kYj_fBwYg3I?autoplay=1',
    'Megatron_3D_Parallelism_vLLM_Deployment.md',
    'Hands-on distributed tensor (TP), pipeline (PP), sequence (SP), and ZeRO-3 data parallelism across multi-node H100 clusters. PagedAttention tuning and continuous batching in production.',
    7
),
(
    'mod_8',
    'ai-infrastructure-factory',
    8,
    'Track 08: AI Infrastructure Migration & Optimisation',
    'Cloud Repatriation: DCGM Profiling & Datacenter TCO Optimization',
    'Architecture Blueprint',
    '80 mins',
    'https://www.youtube-nocookie.com/embed/1k4N6X8XW9o?autoplay=1',
    'AI_Cloud_Repatriation_DCGM_TCO_Blueprint.md',
    'Financial and hardware migration models from hyperscalers to bare-metal co-location. NVIDIA DCGM GPU idle profiling, power capping curves, and high-availability cutover runbooks.',
    8
)
ON CONFLICT (id) DO NOTHING;

