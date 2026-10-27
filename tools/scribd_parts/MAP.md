# scribd_download.py source map

`tools/scribd_download.py` is now a small loader. The real source lives
in these fragments, executed in `MANIFEST.json` order in one shared namespace.
Each fragment keeps its original line range from the 3.1 monolith.

| fragment | original lines | top-level names |
|---|---:|---|
| `001_state_version.py` | 1–356 | VERSION, SAMPLE, UA, OUT, PANEL_PORT, DOC_MARKERS, CHALLENGE, URL_HEAD, IMAGE_RE, JSONP_RE, ASSET_RE, SCAN_RE, TOKEN_RE, TOKEN_SHAPES, VIEWER_WINDOWS, NO_HOPE_RESTS, RETRY_STATUS, HARD_THROTTLE, REFUSALS_IN_A_ROW, PAUSE_LADDER, QUEUE_DROP_AFTER, SHOT_REST_BUDGET, REST_BUDGET, OTHER_HOSTS, PANEL_KEY, PANEL_ORIGINS, PANEL_COOKIE, MIN_PAGE_PX, PREVIEW_MIN_PX, ABSOLUTE_MIN_PX, ASPECT_RANGE |
| `002_find_cookies.py` | 357–369 | find_cookies |
| `003_read_cookie_lines.py` | 370–388 | read_cookie_lines |
| `004_scribd_only.py` | 389–407 | scribd_only |
| `005_cookie_report.py` | 408–424 | cookie_report |
| `006_load_cookies.py` | 425–428 | load_cookies |
| `007_cookie_sentence.py` | 429–435 | cookie_sentence |
| `008_state_base.py` | 436–443 | BASE, _POOL |
| `009_rebase.py` | 444–451 | rebase |
| `010_full_url.py` | 452–468 | full_url |
| `011_connection.py` | 469–481 | _connection |
| `012_forget.py` | 482–490 | _forget |
| `013_state_scrape_do.py` | 491–508 | SCRAPE_DO, SCRAPE_REFUSED, SCRAPE_BUDGET, SCRAPE_HOSTS, _scrape_left, _scrape_lock, _scrape_said |
| `014_scrape_url.py` | 509–514 | scrape_url |
| `015_scrape_open.py` | 515–523 | _scrape_open |
| `016_scrape_take.py` | 524–532 | _scrape_take |
| `017_scrape_get.py` | 533–549 | _scrape_get |
| `018_decompress.py` | 550–566 | _decompress |
| `019_fetch.py` | 567–623 | fetch |
| `020_retry_after.py` | 624–639 | retry_after |
| `021_http_reason.py` | 640–651 | http_reason |
| `022_doc_id_of.py` | 652–657 | doc_id_of |
| `023_text_of.py` | 658–669 | text_of |
| `024_describe.py` | 670–676 | describe |
| `025_image_url_for.py` | 677–685 | image_url_for |
| `026_jsonp_from_image.py` | 686–697 | jsonp_from_image |
| `027_jsonp_for_page.py` | 698–709 | jsonp_for_page |
| `028_alternate_host.py` | 710–719 | alternate_host |
| `029_jwt_exp.py` | 720–732 | jwt_exp |
| `030_jwt_claims.py` | 733–752 | jwt_claims |
| `031_unlocked_range.py` | 753–765 | unlocked_range |
| `032_jsonp_variants_of.py` | 766–780 | jsonp_variants_of |
| `033_jwt_ok.py` | 781–798 | jwt_ok |
| `034_usable_token.py` | 799–814 | usable_token |
| `035_token_score.py` | 815–824 | token_score |
| `036_harvest_token.py` | 825–852 | harvest_token |
| `037_with_token.py` | 853–865 | with_token |
| `038_strip_token.py` | 866–877 | strip_token |
| `039_redact.py` | 878–892 | redact |
| `040_token_note.py` | 893–905 | token_note |
| `041_token.py` | 906–924 | Token |
| `042_state_link_in_text_re.py` | 925–935 | LINK_IN_TEXT_RE |
| `043_links_from_text.py` | 936–951 | links_from_text |
| `044_panel_gate.py` | 952–974 | panel_gate |
| `045_file_token.py` | 975–989 | file_token |
| `046_token_ok.py` | 990–1005 | token_ok |
| `047_panel_cookie.py` | 1006–1011 | panel_cookie |
| `048_cors_headers.py` | 1012–1027 | cors_headers |
| `049_state_keep_files.py` | 1028–1032 | KEEP_FILES, MAX_OUT_MB, CACHE_DAYS |
| `050_folder_mb.py` | 1033–1043 | folder_mb |
| `051_prune_out.py` | 1044–1099 | prune_out |
| `052_panel_files.py` | 1100–1124 | panel_files |
| `053_bookmarklet.py` | 1125–1143 | bookmarklet |
| `054_html_escape.py` | 1144–1150 | html_escape |
| `055_safe_name.py` | 1151–1164 | safe_name |
| `056_title_from_html.py` | 1165–1188 | title_from_html |
| `057_oembed.py` | 1189–1201 | oembed |
| `058_sof_candidates.py` | 1202–1220 | _sof_candidates |
| `059_jpeg_frames.py` | 1221–1263 | jpeg_frames |
| `060_biggest_frame.py` | 1264–1270 | biggest_frame |
| `061_small_frame.py` | 1271–1289 | small_frame |
| `062_best_frame_any_shape.py` | 1290–1297 | best_frame_any_shape |
| `063_jpeg_size.py` | 1298–1317 | jpeg_size |
| `064_jpeg_orientation.py` | 1318–1357 | jpeg_orientation |
| `065_png_chunks.py` | 1358–1385 | png_chunks |
| `066_png_for_pdf.py` | 1386–1418 | png_for_pdf |
| `067_unfilter.py` | 1419–1453 | _unfilter |
| `068_unpack_bits.py` | 1454–1464 | _unpack_bits |
| `069_png_to_raw.py` | 1465–1526 | png_to_raw |
| `070_raw_page.py` | 1527–1535 | _raw_page |
| `071_pillow_page.py` | 1536–1555 | pillow_page |
| `072_pillow_size.py` | 1556–1574 | pillow_size |
| `073_with_flags.py` | 1575–1582 | with_flags |
| `074_scan_for_pdf.py` | 1583–1651 | scan_for_pdf |
| `075_size_text.py` | 1652–1660 | size_text |
| `076_describe_image.py` | 1661–1689 | describe_image |
| `077_looks_like_image.py` | 1690–1694 | looks_like_image |
| `078_page_can_be_this_small.py` | 1695–1707 | page_can_be_this_small |
| `079_plausible_page.py` | 1708–1715 | plausible_page |
| `080_pdf_string.py` | 1716–1722 | pdf_string |
| `081_median_page.py` | 1723–1734 | median_page |
| `082_house_sheet.py` | 1735–1745 | house_sheet |
| `083_sheet_list.py` | 1746–1752 | sheet_list |
| `084_placement.py` | 1753–1775 | _placement |
| `085_image_matrix.py` | 1776–1792 | _image_matrix |
| `086_state_helvetica_widths.py` | 1793–1807 | HELVETICA_WIDTHS, TEXT_CHAR_EM |
| `087_text_width.py` | 1808–1821 | text_width |
| `088_wrap_to_width.py` | 1822–1852 | wrap_to_width |
| `089_state_winansi_stand_in.py` | 1853–1858 | WINANSI_STAND_IN |
| `090_can_winansi.py` | 1859–1872 | can_winansi |
| `091_pdf_visible_text.py` | 1873–1894 | pdf_visible_text |
| `092_state_text_sizes.py` | 1895–1900 | TEXT_SIZES, SHOT_BLANK_ROWS |
| `093_looks_blank_shot.py` | 1901–1915 | looks_blank_shot |
| `094_sheet_scale.py` | 1916–1926 | sheet_scale |
| `095_text_body_page.py` | 1927–2042 | text_body_page |
| `096_text_layer.py` | 2043–2081 | text_layer |
| `097_build_pdf.py` | 2082–2200 | build_pdf |
| `098_state_xref_entry_re.py` | 2201–2205 | XREF_ENTRY_RE |
| `099_verify_pdf.py` | 2206–2215 | verify_pdf |
| `100_verify_bytes.py` | 2216–2347 | verify_bytes |
| `101_state_stall_seconds.py` | 2348–2352 | STALL_SECONDS |
| `102_job.py` | 2353–2577 | Job |
| `103_state_job.py` | 2578–2579 | JOB |
| `104_gate.py` | 2580–2623 | Gate |
| `105_sources.py` | 2624–2697 | Sources |
| `106_state_text_of_jsonp_re.py` | 2698–2703 | TEXT_OF_JSONP_RE, BREAK_TAG_RE, TAG_STRIP_RE, SPACE_RE |
| `107_html_to_text.py` | 2704–2726 | html_to_text |
| `108_state_line_mark.py` | 2727–2742 | LINE_MARK, WORDS_CACHE_TAG, STYLE_TAG_RE, STYLE_ATTR_RE, TOP_RE |
| `109_positioned_lines.py` | 2743–2783 | positioned_lines |
| `110_encode_page_lines.py` | 2784–2796 | encode_page_lines |
| `111_decode_page_lines.py` | 2797–2816 | decode_page_lines |
| `112_words_plain.py` | 2817–2822 | words_plain |
| `113_lines_from_html.py` | 2823–2851 | lines_from_html |
| `114_text_from_jsonp.py` | 2852–2867 | text_from_jsonp |
| `115_state_page_anchor_re.py` | 2868–2902 | PAGE_ANCHOR_RE, SCRIPT_BLOCK_RE, BOILERPLATE, BOILERPLATE_JUNK |
| `116_is_boilerplate.py` | 2903–2914 | is_boilerplate |
| `117_tidy_page_text.py` | 2915–2928 | tidy_page_text |
| `118_embed_text_pages.py` | 2929–2977 | embed_text_pages |
| `119_viewer_fingerprint.py` | 2978–2991 | viewer_fingerprint |
| `120_page_count.py` | 2992–3001 | page_count |
| `121_ctx.py` | 3002–3472 | Ctx |
| `122_run_job.py` | 3473–3524 | run_job |
| `123_run_queue.py` | 3525–3578 | run_queue |
| `124_batch.py` | 3579–3645 | _batch |
| `125_probe.py` | 3646–3713 | _probe |
| `126_state_shots.py` | 3714–3787 | SHOTS, SHOT_HOSTS, SHOT_LOCAL_PORT, SHOOTER_SCAN_RANGES, _scan_host, SHOOTER_SCAN_HOSTS, SCAN_RETRY_AFTER, SCAN_BUDGET, SCAN_LIE_RATIO, _SCAN_LOCK, _SCAN_TRIED, SHOT_FOUND_FOR, SHOT_RETRY_AFTER, _SHOT_CACHE, _SHOT_LOCK, SHOT_SCALE, SHOT_TIMEOUT, MAX_SHOT_PAGES, MAX_SHOT_JOBS |
| `127_set_shots.py` | 3788–3794 | set_shots |
| `128_shot_request.py` | 3795–3800 | shot_request |
| `129_shot_get_headed.py` | 3801–3823 | shot_get_headed |
| `130_shot_get.py` | 3824–3844 | shot_get |
| `131_plain_error.py` | 3845–3868 | plain_error |
| `132_ping_answer.py` | 3869–3897 | ping_answer |
| `133_shooter_cache_path.py` | 3898–3902 | shooter_cache_path |
| `134_read_shooter_cache.py` | 3903–3911 | read_shooter_cache |
| `135_write_shooter_cache.py` | 3912–3919 | write_shooter_cache |
| `136_ping_ok.py` | 3920–3930 | ping_ok |
| `137_scan_for_shooter.py` | 3931–4021 | scan_for_shooter |
| `138_boot_shots_report.py` | 4022–4048 | boot_shots_report |
| `139_discover_shots.py` | 4049–4086 | discover_shots |
| `140_state_max_shard_fraction.py` | 4087–4089 | MAX_SHARD_FRACTION |
| `141_shard_fraction.py` | 4090–4113 | shard_fraction |
| `142_words_look_like_a_page.py` | 4114–4132 | words_look_like_a_page |
| `143_refusal_reason.py` | 4133–4151 | refusal_reason |
| `144_png_size.py` | 4152–4166 | png_size |
| `145_decode_shots.py` | 4167–4207 | decode_shots |
| `146_body_manifest.py` | 4208–4220 | body_manifest |
| `147_entry_manifest.py` | 4221–4240 | entry_manifest |
| `148_state_autostart.py` | 4241–4244 | _AUTOSTART, AUTOSTART_COOLDOWN |
| `149_shooter_log_path.py` | 4245–4248 | shooter_log_path |
| `150_shooter_start_reason.py` | 4249–4264 | shooter_start_reason |
| `151_autostart_shots.py` | 4265–4361 | autostart_shots |
| `152_ensure_shooter.py` | 4362–4390 | ensure_shooter |
| `153_shooter.py` | 4391–4550 | Shooter |
| `154_fit_shots.py` | 4551–4572 | fit_shots |
| `155_download.py` | 4573–5198 | _download |
| `156_state_find_url.py` | 5199–5206 | FIND_URL, FIND_REFERER, FIND_PER_PAGE, FIND_MAX_PAGE |
| `157_search_url.py` | 5207–5221 | search_url |
| `158_documents_in.py` | 5222–5243 | documents_in |
| `159_hit_from.py` | 5244–5272 | hit_from |
| `160_find_refusal.py` | 5273–5285 | find_refusal |
| `161_count_in.py` | 5286–5295 | count_in |
| `162_state_panel_jobs.py` | 5296–5298 | PANEL_JOBS |
| `163_as_channels.py` | 5299–5315 | as_channels |
| `164_as_limit.py` | 5316–5324 | as_limit |
| `165_as_page.py` | 5325–5333 | as_page |
| `166_state_search_stopwords.py` | 5334–5337 | SEARCH_STOPWORDS |
| `167_query_words.py` | 5338–5344 | query_words |
| `168_title_words.py` | 5345–5348 | title_words |
| `169_rank_hits.py` | 5349–5400 | rank_hits |
| `170_find_page.py` | 5401–5447 | find_page |
| `171_find_documents.py` | 5448–5475 | find_documents |
| `172_print_hits.py` | 5476–5485 | print_hits |
| `173_picked_hits.py` | 5486–5505 | picked_hits |
| `174_queue_links.py` | 5506–5521 | queue_links |
| `175_state_embed_css.py` | 5522–5888 | EMBED_CSS, SEND_PAGE, PAGE |
| `176_serve.py` | 5889–6121 | serve |
| `177_selftest.py` | 6122–7677 | selftest |
| `178_main.py` | 7678–7802 | main |
| `179_entry.py` | 7803–7808 | — |
