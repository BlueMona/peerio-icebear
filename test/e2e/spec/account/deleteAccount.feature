Feature: User account access
    Scenario: Account deletion
        Given my email is confirmed
        When  I delete my account
        Then  I should not be able to login