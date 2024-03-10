package main

import (
	"errors"
	"log"
	"os"
	"strings"

	"github.com/meilisearch/meilisearch-go"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/forms"
	"github.com/pocketbase/pocketbase/models"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/spf13/cobra"

	_ "pocketbase/migrations"
)

func indexRecord(r *models.Record, client *meilisearch.Client) error {
	documents := []map[string]interface{}{
		{
			"id":             r.Id,
			"author":         r.GetString("author"),
			"name":           r.GetString("name"),
			"description":    r.GetString("description"),
			"location":       r.GetString("location"),
			"distance":       r.GetFloat("distance"),
			"elevation_gain": r.GetFloat("elevation_gain"),
			"duration":       r.GetFloat("duration"),
			"category":       r.Get("category"),
			"completed":      len(r.GetStringSlice("summit_logs")) > 0,
			"created":        r.GetDateTime("created"),
			"public":         r.GetBool("public"),
			"_geo": map[string]float64{
				"lat": r.GetFloat("lat"),
				"lng": r.GetFloat("lon"),
			},
		},
	}

	if _, err := client.Index("trails").AddDocuments(documents); err != nil {
		return err
	}

	return nil
}

func main() {
	app := pocketbase.New()

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		Dir:         "migrations",
		Automigrate: true,
	})

	app.RootCmd.AddCommand(&cobra.Command{
		Use: "seed",
		Run: func(cmd *cobra.Command, args []string) {
			collection, _ := app.Dao().FindCollectionByNameOrId("categories")

			categories := []string{"Hiking", "Walking", "Climbing", "Skiing", "Canoeing", "Biking"}
			for _, element := range categories {
				record := models.NewRecord(collection)
				form := forms.NewRecordUpsert(app, record)
				form.LoadData(map[string]any{
					"name": element,
				})
				f, _ := filesystem.NewFileFromPath("migrations/initial_data/" + strings.ToLower(element) + ".jpg")
				form.AddFiles("img", f)
				form.Submit()
			}

		},
	})

	client := meilisearch.NewClient(meilisearch.ClientConfig{
		Host:   os.Getenv("MEILI_URL"),
		APIKey: os.Getenv("MEILI_MASTER_KEY"),
	})

	app.OnRecordAfterCreateRequest("users").Add(func(e *core.RecordCreateEvent) error {
		userId := e.Record.GetId()

		apiKeyUid := ""
		apiKey := ""

		if keys, err := client.GetKeys(nil); err != nil {
			log.Fatal(err)
		} else {
			for _, k := range keys.Results {
				if k.Name == "Default Search API Key" {
					apiKeyUid = k.UID
					apiKey = k.Key
				}
			}
		}

		if len(apiKey) == 0 || len(apiKeyUid) == 0 {
			return errors.New("unable to locate meilisearch API key")
		}

		searchRules := map[string]interface{}{
			"cities500": map[string]string{},
			"trails": map[string]string{
				"filter": "public = true OR author = " + userId,
			},
		}
		options := &meilisearch.TenantTokenOptions{
			APIKey: apiKey,
		}

		if token, err := client.GenerateTenantToken(apiKeyUid, searchRules, options); err != nil {
			return err
		} else {
			e.Record.Set("token", token)

			if err := app.Dao().SaveRecord(e.Record); err != nil {
				return err
			}
		}

		return nil
	})

	app.OnRecordAfterCreateRequest("trails").Add(func(e *core.RecordCreateEvent) error {
		if err := indexRecord(e.Record, client); err != nil {
			return err
		}
		return nil
	})

	app.OnRecordAfterUpdateRequest("trails").Add(func(e *core.RecordUpdateEvent) error {
		if err := indexRecord(e.Record, client); err != nil {
			return err
		}
		return nil
	})

	app.OnRecordAfterDeleteRequest("trails").Add(func(e *core.RecordDeleteEvent) error {
		if _, err := client.Index("trails").DeleteDocument(e.Record.Id); err != nil {
			return err
		}
		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
