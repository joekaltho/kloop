#!/usr/bin/env bash
# Runs the migrations + SQL assertions against a throwaway database.
# Uses standard libpq env vars (PGHOST, PGUSER, PGPASSWORD, PGPORT); the user needs CREATEDB and CREATEROLE.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${KLOOP_TEST_DB:-kloop_referral_test}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
P="psql -v ON_ERROR_STOP=1 -q -d $DB"
$P -f tests/db/bootstrap.sql
$P -f supabase/migrations/0001_waitlist.sql
$P -f tests/db/legacy.sql
$P -f supabase/migrations/0002_referrals.sql
$P -f tests/db/referral.sql
psql -q -d postgres -c "drop database $DB"
