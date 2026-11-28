-- Restaurant submissions, app layer (PARTNER-2; docs/48). Thin public functions for the signed-in
-- person (auth.uid()), so the app never uses a privileged key. Every rule stays in the partner
-- schema's own functions (20261118000100). Granted to signed-in members only; guests get nothing.
-- A representative sees only their own claims and their own dishes' review status; the moderator
-- views are publisher-only. Nothing here publishes anything.

-- What a claim link shows: the place's name and street, nothing else. Rejected places are not offered.
create function partner.claim_target(p_actor uuid, p_candidate uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v jsonb;
begin
  if p_actor is null then raise exception 'PARTNER_SIGN_IN_REQUIRED' using errcode = 'PT401'; end if;
  select jsonb_build_object('candidateId', pc.id, 'name', pc.name, 'street', pc.street, 'postcode', pc.postcode,
                            'myClaim', (select c.id from partner.claims c where c.candidate_id = pc.id and c.claimant = p_actor))
    into v from catalog_import.place_candidates pc where pc.id = p_candidate and pc.quality <> 'rejected';
  if v is null then raise exception 'PARTNER_PLACE_NOT_FOUND' using errcode = 'PT404'; end if;
  return v;
end;
$$;

-- The representative's own claims, with counts of their dishes by review state. No one else's data.
create function partner.my_claims(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null then raise exception 'PARTNER_SIGN_IN_REQUIRED' using errcode = 'PT401'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'claimId', c.id, 'placeName', pc.name, 'placeStreet', pc.street, 'roleTitle', c.role_title, 'contactEmail', c.contact_email,
             'state', partner.claim_state(c.id), 'createdAt', c.created_at,
             'submissions', (select count(*) from partner.submissions s where s.claim_id = c.id),
             'dishes', (select count(*) from partner.items i join partner.submissions s on s.id = i.submission_id where s.claim_id = c.id),
             'verified', (select count(*) from partner.items i join partner.submissions s on s.id = i.submission_id join partner.item_reviews r on r.item_id = i.id where s.claim_id = c.id and r.decision = 'verified'),
             'rejected', (select count(*) from partner.items i join partner.submissions s on s.id = i.submission_id join partner.item_reviews r on r.item_id = i.id where s.claim_id = c.id and r.decision = 'rejected'))
           order by c.created_at desc)
      from partner.claims c join catalog_import.place_candidates pc on pc.id = c.candidate_id
     where c.claimant = p_actor), '[]'::jsonb);
end;
$$;

-- Moderator overview of claims: who claimed what, and the latest ownership check.
create function partner.claims_overview(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not partner.has_role(p_actor, 'publisher') then raise exception 'PARTNER_MODERATOR_REQUIRED' using errcode = 'PT403'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'claimId', c.id, 'placeName', pc.name, 'placeStreet', pc.street, 'roleTitle', c.role_title, 'contactEmail', c.contact_email,
             'state', partner.claim_state(c.id), 'createdAt', c.created_at, 'own', c.claimant = p_actor,
             'latestCheck', (select jsonb_build_object('method', o.method, 'outcome', o.outcome, 'evidence', o.evidence, 'checkedAt', o.checked_at)
                               from partner.ownership_checks o where o.claim_id = c.id order by o.checked_at desc, o.id desc limit 1))
           order by (partner.claim_state(c.id) = 'pending') desc, c.created_at)
      from partner.claims c join catalog_import.place_candidates pc on pc.id = c.candidate_id), '[]'::jsonb);
end;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'partner' and p.proname in ('claim_target', 'my_claims', 'claims_overview') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

create function public.partner_claim_target(p_candidate uuid)
returns jsonb language sql stable security definer set search_path = '' as $$ select partner.claim_target(auth.uid(), p_candidate); $$;

create function public.partner_create_claim(p_candidate uuid, p_role_title text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object('id', partner.create_claim(auth.uid(), p_candidate, p_role_title, p_email));
exception
  when unique_violation then raise exception 'PARTNER_ALREADY_CLAIMED' using errcode = 'PT409';
  when check_violation then raise exception 'PARTNER_BAD_CLAIM' using errcode = 'PT422';
end $$;

create function public.partner_my_claims()
returns jsonb language sql stable security definer set search_path = '' as $$ select partner.my_claims(auth.uid()); $$;

create function public.partner_licence()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version', l.version, 'text', l.text) from partner.licence_versions l order by l.created_at desc, l.version desc limit 1;
$$;

create function public.partner_submit_menu(p_claim uuid, p_licence text, p_file_name text, p_file_sha256 text, p_document_date date, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'PARTNER_SIGN_IN_REQUIRED' using errcode = 'PT401'; end if;
  v := partner.submit_menu(auth.uid(), p_claim, p_licence, p_file_name, p_file_sha256, p_document_date, p_items);
  return jsonb_build_object('id', v,
    'dishes', (select count(*) from partner.items where submission_id = v),
    'flagged', (select count(*) from partner.items where submission_id = v and cardinality(flags) > 0));
exception
  when unique_violation then raise exception 'PARTNER_ALREADY_SUBMITTED' using errcode = 'PT409';
  when check_violation or invalid_text_representation or numeric_value_out_of_range then raise exception 'PARTNER_BAD_FILE' using errcode = 'PT422';
end $$;

create function public.partner_withdraw(p_claim uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$ select jsonb_build_object('state', partner.withdraw(auth.uid(), p_claim, p_reason)); $$;

create function public.partner_claims_overview()
returns jsonb language sql stable security definer set search_path = '' as $$ select partner.claims_overview(auth.uid()); $$;

create function public.partner_record_check(p_claim uuid, p_method text, p_outcome text, p_evidence text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object('state', partner.record_ownership_check(auth.uid(), p_claim, p_method, p_outcome, p_evidence));
exception when check_violation then raise exception 'PARTNER_BAD_CHECK' using errcode = 'PT422';
end $$;

create function public.partner_moderation_queue()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', q.item_id, 'placeName', q.place_name, 'placeStreet', q.place_street, 'claimantEmail', q.claimant_email, 'ownership', q.ownership,
           'licenceVersion', q.licence_version, 'fileName', q.file_name, 'fileSha256', q.file_sha256, 'documentDate', q.document_date, 'submittedAt', q.submitted_at,
           'name', q.name, 'section', q.section, 'priceUsd', q.price_usd, 'serving', q.serving, 'servingGrams', q.serving_grams, 'ingredients', q.ingredients,
           'allergens', q.allergens, 'crossContact', q.cross_contact, 'dietary', q.dietary, 'nutrition', q.nutrition, 'flags', to_jsonb(q.flags))), '[]'::jsonb)
    from partner.moderation_queue(auth.uid()) q;
$$;

create function public.partner_review_item(p_item uuid, p_decision text, p_note text default null)
returns jsonb language sql security definer set search_path = '' as $$ select jsonb_build_object('decision', partner.review_item(auth.uid(), p_item, p_decision, p_note)); $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'partner\_%' loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
