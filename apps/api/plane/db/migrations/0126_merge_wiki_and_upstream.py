# Merges the fork's wiki migrations (0123_project_wiki .. 0125_page_members_access)
# with upstream's (0123_remove_apitoken_is_service_and_allowed_rate_limit ..
# 0125_reset_project_deploy_board_identity), which both branch off 0122.

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0125_page_members_access"),
        ("db", "0125_reset_project_deploy_board_identity"),
    ]

    operations = []
