-- Active pgsodium pour le chiffrement des tokens sensibles
create extension if not exists pgsodium;

-- Table Profiles : Contient les informations utilisateur, leur clé d'API unique Axis, 
-- et leur clé API Kaggle cryptée
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  axis_api_key text unique not null,
  -- kaggle_api_token contiendra le token kaggle crypté
  kaggle_api_token text,
  -- kaggle_api_token_nonce est requis pour le chiffrement AEAD de pgsodium
  kaggle_api_token_nonce bytea,
  is_pro boolean default false not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Table Jobs Queue : Contient la file d'attente des requêtes d'inférence asynchrones
create table if not exists public.jobs_queue (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  model_target text not null,
  prompt_input jsonb not null,
  prompt_output jsonb,
  status text not null default 'en_attente' check (status in ('en_attente', 'processing', 'completed', 'failed')),
  error_message text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index pour accélérer le polling et le traitement par statut/utilisateur
create index if not exists idx_jobs_queue_user_status on public.jobs_queue(user_id, status);
create index if not exists idx_jobs_queue_status on public.jobs_queue(status) where status = 'en_attente';

-- Activer Row Level Security (RLS) sur toutes les tables
alter table public.profiles enable row level security;
alter table public.jobs_queue enable row level security;

-- =========================================================================
-- POLITIQUES RLS (ROW LEVEL SECURITY)
-- =========================================================================

-- POLITIQUES POUR PROFILES
create policy "Les utilisateurs peuvent voir leur propre profil" 
  on public.profiles
  for select 
  using (auth.uid() = id);

create policy "Les utilisateurs peuvent mettre à jour leur propre profil" 
  on public.profiles
  for update 
  using (auth.uid() = id);

-- POLITIQUES POUR JOBS_QUEUE
create policy "Les utilisateurs peuvent lire leurs propres jobs" 
  on public.jobs_queue
  for select 
  using (auth.uid() = user_id);

create policy "Les utilisateurs peuvent insérer leurs propres jobs" 
  on public.jobs_queue
  for insert 
  with check (auth.uid() = user_id);

create policy "Les utilisateurs peuvent mettre à jour leurs propres jobs (e.g. annulation)" 
  on public.jobs_queue
  for update 
  using (auth.uid() = user_id);

-- =========================================================================
-- TRIGGERS & FONCTIONS UTILITAIRES
-- =========================================================================

-- Fonction pour automatiser l'assignation du user_id lors de l'insertion dans la file d'attente
create or replace function public.handle_job_insert()
returns trigger as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_job_insert
  before insert on public.jobs_queue
  for each row
  execute function public.handle_job_insert();
